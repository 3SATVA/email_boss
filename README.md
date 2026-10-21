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
  admin/                        read-only dashboard: brands, automations flow, template previews,
                                broadcasts (audience, progress, preview), sends, events
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
brands/<slug>/                  vendored brand folders (yonisync, starseed) + .source.json (pulled, don't edit here)
brands.sources.json             where each brand folder comes from (repo / path / ref)
scripts/                        brands-pull, build-manifest, sync-brands-to-db, brand-key, import-csv,
                                broadcast-create, test-send, report-inactive, preview-template
supabase/migrations/            schema
tests/                          vitest + PGlite (real Postgres in memory)
docs/                           brand-repo-format.md, scheduler.md
```

## Commands

```bash
npm install
npm test                         # 66 tests (in-memory Postgres): tokens, isolation, scheduling, broadcasts, import, webhooks, ...
npm run build                    # compiles brands/ -> lib/generated/manifest.json, then next build
npm run brands:validate          # check brand folders (merge-tag typos, missing footer, ...)
npm run preview -- yonisync quiz-01-lets-understand-your-fertility-type   # render a template to an .html file
```

| command | what it does | needs DB |
|---|---|---|
| `npm run brands:pull [-- <slug>]` | Downloads each brand folder listed in `brands.sources.json` from its brand repo (GitHub API, `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth token`), validates it, and replaces `brands/<slug>/`, recording the exact source commit in `brands/<slug>/.source.json`. Commit the result. | no |
| `npm run brands:pull -- --check` | Says whether each vendored copy matches its ref (exit 1 if any is behind). | no |
| `npm run brands:sync-db` | Upserts brand settings + sequences from the manifest into the DB. | yes |
| `npm run brand:key -- <slug>` | Creates/rotates the brand's API key for `/api/subscribe` (printed once, only the hash is stored). | yes |
| `npm run test-send -- --brand <slug> --template <id> --to <email>` | Renders the real email (brand sender, partials, footer) with a `[TEST]` subject to an address in `TEST_RECIPIENTS`. Default provider `log`: nothing is sent, the HTML is written to `.test-sends/`. `--provider ses\|resend` sends for real but also requires `SEND_ENABLED=true`. Options: `--first-name`, `--custom key=value`. | no |
| `npm run broadcast:create -- --brand <slug> --template <id> --audience "<filter>"` | One-off newsletter. Dry run by default: validates the template, shows the subject, recipient count, suppressed count, unknown tags (typo check) and today's warm-up cap. `--commit` saves it as a draft, or `--schedule <ISO>\|now` to send. Also `--exclude`, `--subject`, `--name`. | for counts |
| `npm run import:csv -- --brand <slug> --file <csv> --source <name>` | Dry-run import with aggregate counts only (never prints contact data). Auto-detects systeme.io and Constant Contact exports (`--format` to force). `--tag`, `--suppress-tag`, `--map field=Column`, `--no-custom`, `--commit`. | for `--commit` |
| `npm run report:inactive -- --brand <slug> --days 365` | Cleanup report: subscribed contacts engaged / inactive / too early to judge / never emailed. `--tag inactive:365d --commit` tags the inactive ones so broadcasts can `--exclude` them. | yes |

### Audience filters (broadcasts)

| filter | who |
|---|---|
| `"*"` | everyone subscribed in that brand |
| `"quiz,webinar-email-collected"` | has **any** of these tags |
| `"all:vip,expo-2026"` | has **all** of these tags |
| `--exclude "customer,inactive:365d"` | ...and none of these |

Unsubscribed, bounced and complained contacts are never included. A broadcast bigger than the day's
warm-up cap continues the next day. Cancel one with
`update email_boss.broadcasts set status = 'canceled' where id = '...'` (a trigger cancels its queued emails).
The dashboard (`/admin/brands/<slug>/broadcasts/<id>`) shows audience, progress, engagement and a preview.

### Brand content comes from the brand repos

Each brand repo owns its emails (`3SATVA/susana` -> `emails/yonisync/`, `3SATVA/Starseed-Quest-3` -> `brands/starseed/`).
`brands.sources.json` maps slug -> repo/path/ref. `npm run brands:pull` vendors the folders into `brands/`
with the source commit recorded, and you commit that, so the Vercel build never needs access to the
(private) brand repos and every deploy is reproducible. Michael edits emails by asking the AI in chat: it
edits the brand repo, then re-pulls here and redeploys. No editing UI needed.

### Importing lists

* **systeme.io** (`Email, First name, Last name, ..., Country, Phone number, Tag, Date Registered`): `Tag`
  (comma-separated) becomes lowercase tags (`Webinar Email Collected` -> `webinar-email-collected`),
  `Date Registered` ("2026-02-16 18:26:17 (UTC-8)") becomes the consent date, other non-empty columns become
  custom fields. The export has **no unsubscribe/bounce column**: make sure unsubscribed contacts are excluded
  from the export, or pass `--suppress-tag <tag>` for a tag that marks them.
* **Constant Contact** (`Email address, First name, Last name, Email permission status, Email Opt-in Date,
  Email Opt-out Date, Email Lists, Tags, Source Name, Created At, ...`): permission `Permitted`/`Explicit`/`Implicit`
  -> subscribed; `Unsubscribed`/`Removed` or any opt-out date -> unsubscribed; `Bounced` -> bounced;
  `Not set` (never gave permission) -> unsubscribed and counted as "no permission"; `Pending confirmation`
  -> skipped. List memberships and tags both become tags. Prefer Constant Contact's "all contacts" export,
  which includes unsubscribed contacts, so they stay suppressed here.
* Imports never trigger sequences and never re-activate an unsubscribed/bounced/complained contact.

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
| `RESEND_WEBHOOK_SECRET` | for Resend | `whsec_...` signing secret of the webhook pointing at `/api/webhooks/resend` |
| `TEST_RECIPIENTS` | for test sends | comma-separated allowlist for `npm run test-send` |
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

Two layers, both calling `/api/cron/tick` (idempotent, overlapping runs are safe):

1. **Supabase pg_cron + pg_net, every minute, free (recommended).** Opt-in: the migration only adds helper
   functions. After enabling the two extensions, run once in the Supabase SQL editor:
   ```sql
   select vault.create_secret('<same value as CRON_SECRET>', 'email_boss_cron_secret');
   select email_boss.enable_cron_tick('https://<deployment>/api/cron/tick');   -- '* * * * *' by default
   -- off again: select email_boss.disable_cron_tick();
   ```
   The secret stays in Supabase Vault; neither the URL nor the secret is hard-coded in git.
2. **Vercel Cron, once a day** (`vercel.json`, the Hobby-plan limit), as a fallback.

Details and alternatives: [docs/scheduler.md](docs/scheduler.md).

## Not built yet (next steps)

* A preference center (per-topic opt-outs) and double opt-in for public forms.
* An events retention job (prune old open/click events to stay in Supabase's free 500 MB).
* Wiring the Starseed quiz (Quest repo) and Expo forms to `/api/subscribe`.
