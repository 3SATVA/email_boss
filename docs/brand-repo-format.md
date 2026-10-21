# Brand content format

email_boss is the shared engine. **Each brand repo owns its own emails**: brand settings,
HTML templates and automation (sequence) definitions. email_boss compiles them into the app at
build time (`npm run manifest`) and syncs the sequence definitions into the database
(`npm run brands:sync-db`).

## Folder layout

Put one folder per brand, named exactly like the brand slug. In a brand repo we suggest
`email/<slug>/` (e.g. `3SATVA/susana/email/yonisync/`). The local example lives in
[`brands/yonisync`](../brands/yonisync).

```
<slug>/
  brand.json                    # sender identity + CAN-SPAM address
  partials/
    footer.html                 # REQUIRED: must contain {{unsubscribe_url}} and {{physical_address}}
    header.html                 # optional, any number of partials: {{> header}}
  templates/
    <template-id>.html          # one file per email (front matter + HTML)
    <template-id>.txt           # optional hand-written plain-text part
  sequences/
    <sequence-key>.json         # one file per automation
```

Folder names starting with `_` or `.` are ignored.

## brand.json

```json
{
  "slug": "yonisync",
  "name": "YoniSync",
  "from_name": "Susana Puelles, L.Ac.",
  "from_email": "hello@yonisync.com",
  "reply_to": "hello@yonisync.com",
  "sending_domain": "yonisync.com",
  "physical_address": "123 Example St, Suite 4, Los Angeles, CA 90001",
  "timezone": "America/Los_Angeles",
  "ses_configuration_set": "yonisync-marketing",
  "provider": "ses",
  "links_base_url": "https://email-boss.vercel.app"
}
```

| field | required | notes |
|---|---|---|
| `slug` | yes | lowercase, `a-z0-9-`; must equal the folder name |
| `from_email` | yes | must be on `sending_domain` (or a subdomain of it) |
| `sending_domain` | yes | the domain verified in SES with DKIM |
| `physical_address` | yes | CAN-SPAM. Sending is blocked while it contains `REPLACE_ME` |
| `timezone` | no | the warm-up "day" and date triggers use this timezone |
| `ses_configuration_set` | no | per-brand SES configuration set (events -> SNS) |
| `provider` | no | `ses` / `resend` / `log`; defaults to `EMAIL_PROVIDER` |
| `links_base_url` | no | host for unsubscribe links; defaults to `PUBLIC_BASE_URL` |

## Templates

```html
---
subject: {{first_name|Hi}}, your Fertility Type results are inside
preheader: What your {{custom.fertility_type|fertility type}} means
---
{{> header}}
<tr><td>Hi {{first_name|there}}, your type is {{custom.fertility_type}}.</td></tr>
{{> footer}}
```

* Hand-written, email-safe HTML (tables + inline styles). No editor needed; edit the file
  (or ask the AI to) and redeploy.
* Merge tags: `{{first_name}}`, `{{last_name}}`, `{{email}}`, `{{custom.<field>}}`,
  `{{brand.name}}`, `{{brand.from_name}}`, `{{preheader}}`, `{{unsubscribe_url}}`,
  `{{physical_address}}`, `{{current_year}}`. Fallback: `{{first_name|friend}}`.
* Every value is HTML-escaped. Unknown tags fail the build (catches typos like `{{frist_name}}`).
* Every template must include `{{> footer}}`. The renderer also refuses at send time if the
  unsubscribe link or address is missing.
* Template ids: lowercase `a-z0-9_-` (the file name).

Preview locally: `npm run preview -- yonisync quiz-welcome` writes an HTML file, or open
`/admin/brands/<slug>/templates/<id>` in the dashboard.

## Sequences

```json
{
  "key": "fertility-quiz-welcome",
  "name": "Fertility Type quiz: welcome series",
  "status": "active",
  "trigger": { "type": "signup_source", "source": "fertility-quiz" },
  "exit_tags": ["customer:womb-in-bloom"],
  "allow_reenroll": false,
  "steps": [
    { "key": "welcome",   "delay": "0",  "template": "quiz-welcome" },
    { "key": "education", "delay": "2d", "template": "quiz-day2" },
    { "key": "invite",    "delay": "3d", "template": "quiz-day5", "subject": "Optional subject override" }
  ]
}
```

* `status`: `active` | `paused` (no new enrollments, no sends) | `archived` (running enrollments exit).
  Removing a sequence file archives it.
* `delay` is the wait **after the previous step was queued** (for the first step: after
  enrollment). Formats: `"0"`, `"30m"`, `"2h"`, `"3d"`, `"1w"`, `"1d 12h"`.
* Step `key`s are stable ids: keep them when editing so people mid-sequence aren't re-sent a step.
* Triggers:

| type | config | fires when |
|---|---|---|
| `tag_added` | `{"tag": "quiz:kidney_yin"}` | the tag is newly added to a contact (subscribe API) |
| `signup_source` | `{"source": "fertility-quiz"}` | a contact is created (or re-subscribes) with that `source` |
| `manual` | `{}` | the subscribe API call lists the key in `"enroll": [...]` |
| `date` | `{"field": "due_date", "offset_days": -7, "annual": false}` | `custom_fields.<field>` (YYYY-MM-DD) + offset is today in the brand's timezone; `annual: true` for birthdays |

* `exit_tags`: the contact leaves the sequence as soon as it has one of these tags (e.g. they bought).
* Imports (CSV) never trigger sequences.

## Wiring a brand repo into email_boss

Until the brand repos are wired in, copy the brand folder into `email_boss/brands/`. The intended
setup once the brand repos have an `email/` folder:

1. In the Vercel project for email_boss, add a build step that checks out the brand repos
   (e.g. `git clone --depth 1 https://x-access-token:$BRAND_REPO_TOKEN@github.com/3SATVA/susana .brands/susana`)
   and set `BRANDS_DIRS=brands:.brands/susana/email`.
2. A push to a brand repo triggers an email_boss redeploy via a Vercel deploy hook.
3. After deploy, run `npm run brands:sync-db` (or add it to the build) to update sequences.
