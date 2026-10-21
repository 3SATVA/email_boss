import { getDb, isDbConfigured } from "../db";
import { remainingToday } from "../engine/runner";
import type { BrandRow } from "../engine/types";

export async function loadBrandStats() {
  if (!isDbConfigured()) return { configured: false as const, brands: [] };
  const db = getDb();
  const brands = await db.query<BrandRow>(`select * from email_boss.brands order by slug`);
  const counts = await db.query<{ brand_id: string; status: string; n: number }>(
    `select brand_id, status, count(*)::int as n from email_boss.contacts group by brand_id, status`,
  );
  const out = [];
  for (const b of brands) {
    const byStatus: Record<string, number> = {};
    for (const c of counts.filter((x) => x.brand_id === b.id)) byStatus[c.status] = c.n;
    const cap = await remainingToday(db, b, new Date());
    out.push({ brand: b, byStatus, cap });
  }
  return { configured: true as const, brands: out };
}

export async function loadBrandDetail(slug: string) {
  if (!isDbConfigured()) return null;
  const db = getDb();
  const [brand] = await db.query<BrandRow>(`select * from email_boss.brands where slug = $1`, [slug]);
  if (!brand) return null;
  const enrollment = await db.query<{ key: string; status: string; n: number }>(
    `select s.key, e.status, count(*)::int as n from email_boss.enrollments e
       join email_boss.sequences s on s.id = e.sequence_id where e.brand_id = $1 group by s.key, e.status`,
    [brand.id],
  );
  const sends = await db.query<{ id: string; email: string; template_id: string; kind: string; status: string; subject: string | null; error: string | null; created_at: Date; sent_at: Date | null }>(
    `select s.id, c.email, s.template_id, s.kind, s.status, s.subject, s.error, s.created_at, s.sent_at
       from email_boss.sends s join email_boss.contacts c on c.id = s.contact_id
      where s.brand_id = $1 order by s.created_at desc limit 50`,
    [brand.id],
  );
  const events = await db.query<{ type: string; email: string | null; occurred_at: Date; data: Record<string, unknown> }>(
    `select e.type, c.email, e.occurred_at, e.data from email_boss.events e
       left join email_boss.contacts c on c.id = e.contact_id
      where e.brand_id = $1 order by e.occurred_at desc limit 50`,
    [brand.id],
  );
  const broadcasts = await db.query<{ name: string; status: string; scheduled_at: Date | null; recipient_count: number | null; template_id: string }>(
    `select name, status, scheduled_at, recipient_count, template_id from email_boss.broadcasts where brand_id = $1 order by created_at desc limit 20`,
    [brand.id],
  );
  const queue = await db.query<{ status: string; n: number }>(
    `select status, count(*)::int as n from email_boss.sends where brand_id = $1 group by status`,
    [brand.id],
  );
  return { brand, enrollment, sends, events, broadcasts, queue };
}

export function fmt(d: Date | string | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }) + " PT";
}
