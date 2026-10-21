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

Migration `20261021210000_cron_tick_helpers.sql` adds `email_boss.enable_cron_tick(url, schedule)` and
`email_boss.disable_cron_tick()`; it schedules nothing by itself. To turn it on:

1. Supabase dashboard > Database > Extensions: enable **pg_cron** and **pg_net**.
2. SQL editor:
   ```sql
   -- the same value as CRON_SECRET in the Vercel project
   select vault.create_secret('<CRON_SECRET>', 'email_boss_cron_secret');
   select email_boss.enable_cron_tick('https://<your-deployment>/api/cron/tick');          -- every minute
   -- or: select email_boss.enable_cron_tick('https://<your-deployment>/api/cron/tick', '*/5 * * * *');
   ```
3. Check it: `select * from cron.job_run_details order by start_time desc limit 5;` and
   `select status_code, created from net._http_response order by created desc limit 5;` (expect 200).

The job reads the secret from Vault at run time, so it never appears in `cron.job`. Turn it off with
`select email_boss.disable_cron_tick();`. Rotating `CRON_SECRET`: update both Vercel and
`select vault.update_secret((select id from vault.secrets where name = 'email_boss_cron_secret'), '<new>');`.

Cost: free. pg_cron/pg_net are included in every Supabase plan, and a 1-minute tick is about 43k tiny
function invocations a month, well inside Vercel Hobby's included usage.

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
