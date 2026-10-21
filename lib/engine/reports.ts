import type { Db } from "../db";
import { addMinutes } from "./schedule";

export interface InactiveReport {
  days: number;
  subscribed: number;
  /** opened or clicked within the window */
  engaged: number;
  /** got at least one email more than 7 days ago, no open/click in the window */
  inactive: number;
  /** never emailed by email_boss yet (e.g. fresh imports): no engagement data */
  noData: number;
  /** emailed only in the last 7 days: too early to judge */
  tooEarly: number;
}

const BASE = `
  with c as (
    select c.id,
      exists (select 1 from email_boss.events e where e.contact_id = c.id and e.type in ('open', 'click') and e.occurred_at >= $2::timestamptz) as engaged,
      exists (select 1 from email_boss.events e where e.contact_id = c.id and e.type = 'sent') as ever_sent,
      exists (select 1 from email_boss.events e where e.contact_id = c.id and e.type = 'sent' and e.occurred_at < $3::timestamptz) as sent_before_grace
    from email_boss.contacts c
    where c.brand_id = $1 and c.status = 'subscribed'
  )`;

/**
 * Who hasn't engaged in N days. Apple Mail Privacy Protection auto-"opens" many emails, so
 * inactive here is conservative (true inactives are probably more).
 */
export async function inactiveReport(db: Db, brandId: string, days: number, now = new Date()): Promise<InactiveReport> {
  const since = addMinutes(now, -days * 1440).toISOString();
  const grace = addMinutes(now, -7 * 1440).toISOString();
  const [r] = await db.query<{ subscribed: number; engaged: number; inactive: number; no_data: number; too_early: number }>(
    `${BASE}
     select count(*)::int as subscribed,
            count(*) filter (where engaged)::int as engaged,
            count(*) filter (where not engaged and sent_before_grace)::int as inactive,
            count(*) filter (where not ever_sent)::int as no_data,
            count(*) filter (where not engaged and ever_sent and not sent_before_grace)::int as too_early
       from c`,
    [brandId, since, grace],
  );
  return { days, subscribed: r.subscribed, engaged: r.engaged, inactive: r.inactive, noData: r.no_data, tooEarly: r.too_early };
}

/** Tag the inactive contacts (e.g. "inactive:365d") so broadcasts can exclude them. Returns how many got the tag. */
export async function tagInactive(db: Db, brandId: string, days: number, tag: string, now = new Date()): Promise<number> {
  const since = addMinutes(now, -days * 1440).toISOString();
  const grace = addMinutes(now, -7 * 1440).toISOString();
  await db.query(`insert into email_boss.tags (brand_id, name) values ($1, $2) on conflict (brand_id, name) do nothing`, [brandId, tag]);
  const rows = await db.query(
    `${BASE}
     insert into email_boss.contact_tags (contact_id, tag_id, brand_id, added_at)
     select c.id, t.id, $1, $5::timestamptz from c join email_boss.tags t on t.brand_id = $1 and t.name = $4
      where not c.engaged and c.sent_before_grace
     on conflict do nothing
     returning contact_id`,
    [brandId, since, grace, tag, now.toISOString()],
  );
  return rows.length;
}
