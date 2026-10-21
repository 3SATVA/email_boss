# email_boss

A small, self-owned email platform for three strictly separate brands
(**Conscious Life Expo**, **Susana Puelles / YoniSync**, **Starseed**):

* **Contacts live in your own Supabase Postgres**: no platform holds the list hostage.
* **Sending goes through Amazon SES** (about $0.10 per 1,000 emails, no per-contact fees).
  Resend is a drop-in alternative; adding another provider (e.g. Postmark) is one small adapter.
* **Emails are hand-made HTML files** in each brand's repo. There's no WYSIWYG editor; you edit
  by changing the file (or asking the AI to).
* Unsubscribes, bounces and complaints are handled automatically, sequences run on a scheduler,
  and there's a read-only dashboard.

> Status: v1 engine. No AWS, Supabase or Vercel resources have been created yet, and it ships in
> **dry-run mode** (`SEND_ENABLED` unset = nothing is ever emailed).

## Architecture

```mermaid
flowchart LR
  subgraph BrandRepos["Brand repos (own their content)"]
    S["3SATVA/susana<br/>email/yonisync/*"]
    Q["Starseed repo<br/>email/starseed/*"]
    E["Conscious Life repo<br/>email/expo/*"]
  end
  subgraph Sites["Brand sites & forms"]
    QZ["yonisync-quiz<br/>(server-side call)"]
    F["other signup forms"]
  end
  subgraph EB["email_boss (Next.js on Vercel)"]
    M["build: manifest.json<br/>templates + sequences"]
    SUB["POST /api/subscribe<br/>brand API key"]
    TICK["/api/cron/tick<br/>sequence runner + queue"]
    UNS["/unsubscribe page +<br/>RFC 8058 one-click"]
    WH["/api/webhooks/ses<br/>SNS signature verified"]
    DASH["/admin<br/>read-only dashboard"]
  end
  DB[("Supabase Postgres<br/>schema email_boss<br/>RLS on, no public access")]
  SES["Amazon SES<br/>per-brand domain + config set"]
  SNS["Amazon SNS"]
  INBOX["Subscribers' inboxes"]
  CRON["Vercel Cron / pg_cron"]

  S & Q & E -->|BRANDS_DIRS at build| M
  QZ & F --> SUB --> DB
  CRON --> TICK
  TICK <--> DB
  TICK -->|SendEmail + List-Unsubscribe headers| SES --> INBOX
  INBOX -->|one-click / link| UNS --> DB
  SES -->|bounce / complaint / delivery / open / click| SNS --> WH --> DB
  DASH --> DB
```

### Brand isolation (enforced by the database)

* The same email address in two brands is two independent contact rows with separate status,
  tags, consent and history.
* Every child table carries `brand_id`, and composite foreign keys (`(contact_id, brand_id)` ->
  `contacts(id, brand_id)`, and likewise for sequences, tags, enrollments, broadcasts and sends) make
  it **impossible** to enroll, tag or queue a send for a contact of another brand, even with a bug in
  app code. Tests prove the DB rejects it.
* API keys, unsubscribe tokens and SES events are all scoped to one brand. An unsubscribe or bounce
  in Expo never touches the same person's YoniSync or Starseed subscription.
* Each brand sends from its own authenticated domain and SES configuration set, so reputations don't mix.

### Data model (`supabase/migrations`)

| table | what |
|---|---|
| `brands` | sender identity, sending domain, CAN-SPAM address, timezone, status, warm-up start, daily cap override, API key hash |
| `contacts` | per brand: email, names, `status` (subscribed / unsubscribed / bounced / complained), source, `custom_fields` jsonb, consent time/IP/source |
| `tags`, `contact_tags` | per-brand tags (e.g. `quiz:kidney_yin`, `expo-2026`) |
| `sequences`, `sequence_steps` | automations synced from brand repos: trigger (`tag_added`, `signup_source`, `manual`, `date`), steps with delays + template ids |
| `enrollments` | a contact's progress through a sequence (`next_run_at`) |
| `broadcasts` | one-off campaigns to a tag segment of one brand |
| `sends` | the outbound queue + delivery log (idempotent per step / per broadcast recipient) |
| `events` | subscribe, sent, delivered, open, click, bounce, complaint, unsubscribe, ... |

Everything is in the `email_boss` schema (not exposed by Supabase's public API), RLS is enabled on
every table with **no policies**, and `anon` / `authenticated` have no grants. Only the server,
connecting with `SUPABASE_DB_URL`, can read or write.

## Repo layout

```
app/
  api/subscribe/route.ts        POST: add/update a contact (brand API key), tags, triggers sequences
  api/unsubscribe/route.ts      POST: RFC 8058 one-click + confirm-page form (GET never unsubscribes)
  api/webhooks/ses/route.ts     SNS -> SES events: bounces/complaints auto-suppress
  api/cron/tick/route.ts        scheduler pass (Vercel Cron, Bearer CRON_SECRET)
  api/admin/{login,logout}      dashboard session (ADMIN_PASSWORD)
  unsubscribe/                  confirm page + done page
  admin/                        read-only dashboard: brands, automations flow, template previews, sends, events
lib/
  db.ts                         tiny Db interface (postgres.js in prod, PGlite in tests)
  tokens.ts                     unsubscribe tokens, brand API keys, admin session
  templates.ts                  merge tags, partials, compliance checks, html->text
  sns.ts                        SNS signature verification
  brands/                       brand folder format (zod), loader, compiled registry
  engine/contacts.ts            subscribe / tags / enroll / suppress
  engine/runner.ts              date triggers, sequence steps, broadcasts, capped delivery
  engine/schedule.ts            delays + warm-up schedule
  engine/ses-events.ts          bounce / complaint / delivery / open / click handling
  engine/sync.ts                brand settings + sequences -> DB
  import/csv.ts                 CSV parsing + safe import
  providers/                    ses.ts (SESv2), resend.ts, log.ts (dry run), index.ts (safety switch)
brands/yonisync/                example brand folder (format: docs/brand-repo-format.md)
scripts/                        build-manifest, sync-brands-to-db, brand-key, import-csv, preview-template
supabase/migrations/            schema
tests/                          vitest + PGlite (real Postgres in memory)
docs/                           brand-repo-format.md, scheduler.md
```

## Commands

```bash
npm install
npm test                         # 49 tests: tokens, isolation, scheduling, import, webhooks, templates
npm run build                    # compiles brands -> lib/generated/manifest.json, then next build
npm run brands:validate          # check brand folders (merge-tag typos, missing footer, ...)
npm run preview -- yonisync quiz-welcome        # render a template to an .html file

# need SUPABASE_DB_URL:
npm run brands:sync-db           # upsert brands + sequences from the manifest
npm run brand:key -- yonisync    # create/rotate the brand's API key (printed once)
npm run import:csv -- --brand starseed --file starseed.csv --source constant_contact --tag imported:cc   # dry run
npm run import:csv -- ... --commit
```

## Subscribe API

```http
POST /api/subscribe
Authorization: Bearer eb_yonisync_xxxxxxxx
Content-Type: application/json

{
  "email": "maya@example.com",
  "first_name": "Maya",
  "source": "fertility-quiz",
  "tags": ["quiz:kidney_yin"],
  "custom_fields": { "fertility_type": "Kidney Yin Deficiency" },
  "consent": true,
  "ip": "203.0.113.7"
}
```

Call it **from your server** (e.g. the quiz's `/api/lead` route), never from browser JavaScript,
because the key would leak. Rules: a new contact is subscribed with consent time/IP; an unsubscribed
contact only comes back with `"consent": true` (a fresh opt-in); bounced/complained contacts never
come back. Matching active sequences start automatically.

## Environment variables

See [`.env.example`](.env.example).

| var | required | purpose |
|---|---|---|
| `SUPABASE_DB_URL` | yes | Postgres connection string (Supabase **pooler**, transaction mode, port 6543) |
| `PUBLIC_BASE_URL` | yes | this deployment's URL, used in unsubscribe links |
| `UNSUBSCRIBE_SECRET` | yes | HMAC key for unsubscribe tokens (`openssl rand -base64 32`). Don't change it casually: old links stop working (use `UNSUBSCRIBE_SECRET_PREVIOUS` to rotate) |
| `CRON_SECRET` | yes | Vercel Cron sends it as `Authorization: Bearer ...` |
| `ADMIN_PASSWORD` | yes | dashboard password, 12+ chars |
| `SEND_ENABLED` | no | must be exactly `true` to send real email. Anything else = dry run |
| `EMAIL_PROVIDER` | no | `ses` (default when enabled) / `resend` / `log` |
| `SES_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | for SES | IAM user allowed only `ses:SendEmail` |
| `SNS_TOPIC_ARNS` | for SES | comma-separated SNS topic ARNs allowed to call the webhook |
| `RESEND_API_KEY` | for Resend | |
| `SEND_RATE_PER_SECOND` | no | default 1 (SES sandbox). Set to your SES max send rate |
| `SEND_BATCH_LIMIT`, `SEND_TIME_BUDGET_MS` | no | per-run limits (defaults 200 / 45s) |
| `BRANDS_DIRS` | no | `:`-separated roots of brand folders compiled at build (default `brands`) |

## Setting up Amazon SES (step by step)

Do this once per AWS account, then the domain steps once **per brand domain**. Pick one region
(e.g. `us-west-2`) and use it everywhere.

1. **AWS account.** Create one (or use an existing one), turn on MFA for the root user, and set a
   billing alarm (e.g. $20).
2. **Verify each sending domain** (SES console > Configuration > Identities > Create identity > Domain):
   * **Easy DKIM** (RSA 2048): SES gives you 3 `CNAME` records. Add them at the DNS host (GoDaddy for
     yonisync.com).
   * **Custom MAIL FROM domain**, e.g. `bounce.yonisync.com`: add the `MX` record
     (`10 feedback-smtp.us-west-2.amazonses.com`) and the `TXT` record `v=spf1 include:amazonses.com ~all`
     **on that subdomain**. This makes SPF align with your domain for DMARC, and it doesn't touch the
     root SPF record that Google Workspace uses.
   * **DMARC**: yonisync.com already has `p=none`, which is enough to start (Gmail/Yahoo require at
     least `p=none`). Add a `rua=mailto:` address to receive reports, and after a few clean weeks move
     to `p=quarantine`. Each other brand domain needs its own `_dmarc` TXT record.
3. **Configuration set per brand** (e.g. `yonisync-marketing`, `starseed-marketing`, `expo-marketing`):
   * Event destination -> **Amazon SNS**, event types: Bounce, Complaint, Delivery, Reject,
     Delivery delay (Open and Click are optional; they add tracking pixels and link rewriting).
   * Put the set's name in that brand's `brand.json` (`ses_configuration_set`).
   * Leave the account-level suppression list on (bounces + complaints). A hard-bounced address is
     dead for every brand anyway.
4. **SNS topic** (e.g. `email-boss-events`): add an **HTTPS subscription** to
   `https://<deployment>/api/webhooks/ses`, and put the topic ARN in `SNS_TOPIC_ARNS`. The webhook
   verifies SNS signatures and confirms the subscription automatically.
5. **IAM user for sending**, with only this policy, and its access key in Vercel env:
   ```json
   { "Version": "2012-10-17", "Statement": [
     { "Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*" } ] }
   ```
6. **Leave the sandbox.** New accounts can only send to verified addresses, 200/day, 1/s. Request
   production access (SES console > Account dashboard). Describe it honestly: opt-in lists collected
   on your own sites, double-checked imports, automatic bounce/complaint suppression, one-click
   unsubscribe in every email, and a gradual warm-up. Approval usually takes about a day.
7. **Test** in the sandbox by verifying your own addresses, set `SEND_ENABLED=true` on a preview
   deployment only, and send to yourself. Check Gmail's "Show original" for `SPF: PASS`,
   `DKIM: PASS`, `DMARC: PASS` and the unsubscribe link next to the sender name.

## Deliverability and the warm-up plan

The engine enforces a **per-brand daily cap** that starts at 50/day and ramps up over about four
weeks (`DEFAULT_WARMUP_SCHEDULE` in `lib/engine/schedule.ts`). Nothing sends until a brand's warm-up
has started:

```sql
update email_boss.brands set status = 'active', warmup_started_on = current_date where slug = 'starseed';
-- optional manual cap for a day:
update email_boss.brands set daily_cap_override = 300 where slug = 'starseed';  -- null = back to schedule
```

| day | cap/day | | day | cap/day |
|---|---|---|---|---|
| 1 | 50 | | 13 | 3,000 |
| 3 | 150 | | 16 | 5,000 |
| 5 | 400 | | 20 | 11,000 |
| 8 | 1,000 | | 25 | 25,000 |
| 10 | 1,600 | | 29+ | 50,000 |

Plan, one brand at a time:

1. **Clean each list before importing**: drop hard bounces and anyone who hasn't opened or clicked in
   about 12 months (keep them in a separate CSV; maybe a single re-engagement email later).
2. **Starseed first** (about 1,500): by day 10 the daily cap covers the whole list in one send. Watch the bounce rate
   (keep it under 2%; SES reviews accounts at 5%) and the complaint rate (keep it under 0.1%; Gmail's
   hard limit is 0.3%) in Google Postmaster Tools.
3. **YoniSync** (about 3,000) next, then **Expo** (about 30,000) last. Send to the most engaged
   segment first. A broadcast larger than the day's cap simply continues the next day.
4. Keep the same From name and address, send on a regular cadence, and don't buy lists.

## Costs (approximate; check current AWS pricing before relying on these)

| item | estimate for ~34.5k contacts, 4 emails/month (~140k sends) |
|---|---|
| Amazon SES | ~$0.10 per 1,000 emails = **~$14/month** |
| SNS notifications to the webhook | cents |
| Supabase | Free tier (500 MB) to start; **$25/mo Pro** once the events table grows (~100 MB/month at this volume, so prune old open/click events or upgrade) |
| Vercel | Hobby (free) works with daily cron; minute-level scheduling needs Pro ($20/mo) **or** the free Supabase pg_cron option in [docs/scheduler.md](docs/scheduler.md) |
| Resend (alternative) | free for 3,000/month, ~$20/mo for 50k |

That's roughly **$15-40/month** for all three brands, compared with roughly $400+/month on Constant Contact.

## Scheduler

`vercel.json` runs `/api/cron/tick` once a day (the most Vercel Hobby allows). For quiz welcome
emails within minutes, use Supabase pg_cron (free) or Vercel Pro. See [docs/scheduler.md](docs/scheduler.md).

## Not in v1 (next steps)

* Wiring brand repos in at build (`BRANDS_DIRS` + deploy hooks), per [docs/brand-repo-format.md](docs/brand-repo-format.md).
* A broadcast-creation script/UI (the table + sending logic exist; create rows with SQL for now).
* Resend webhooks (SES webhooks are done), double opt-in, preference center, an events retention job.
* Re-creating the systeme.io / Constant Contact automations as sequence files.
