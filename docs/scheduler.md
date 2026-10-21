# Running the scheduler

`GET /api/cron/tick` (with `Authorization: Bearer $CRON_SECRET`) runs one pass: date-trigger
enrollments, due sequence steps, scheduled broadcasts, then sends queued mail within each
brand's warm-up cap. It's idempotent and safe to call as often as you like.

| option | cost | frequency | setup |
|---|---|---|---|
| Vercel Cron, **Hobby** (what `vercel.json` ships with) | free | once a day (9-10 AM PT) | nothing |
| Vercel Cron, **Pro** | $20/mo | every minute | change schedule to `*/5 * * * *` |
| **Supabase pg_cron + pg_net** (recommended free option) | free | every minute | SQL below |
| GitHub Actions schedule | free on public repos | ~every 5-15 min (best effort) | workflow below |

Once a day is fine for long nurture sequences, but a quiz "welcome" email should go out within
minutes, so use pg_cron (or Pro) before launching welcome series.

## Supabase pg_cron + pg_net

Run in the Supabase SQL editor (Database > Extensions: enable `pg_cron` and `pg_net` first).
Store the secret in Vault rather than inline:

```sql
select vault.create_secret('<CRON_SECRET>', 'email_boss_cron_secret');

select cron.schedule(
  'email-boss-tick',
  '*/2 * * * *',
  $$
  select net.http_get(
    url := 'https://<your-deployment>/api/cron/tick',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'email_boss_cron_secret')
    ),
    timeout_milliseconds := 60000
  );
  $$
);
```

## GitHub Actions

`.github/workflows/tick.yml` (needs a `CRON_SECRET` repo secret and the deployment URL):

```yaml
name: tick
on:
  schedule: [{ cron: "*/10 * * * *" }]
  workflow_dispatch: {}
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsS -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" https://<your-deployment>/api/cron/tick
```
