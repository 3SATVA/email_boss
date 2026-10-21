import { pgArray, type Db } from "../db";
import { normalizeTag } from "./types";

export interface Segment {
  include_tags: string[];
  exclude_tags: string[];
  match: "any" | "all";
}

/**
 * Audience filter syntax (CLI):
 *   "*"                   every subscribed contact of the brand
 *   "tag-a,tag-b"         has ANY of these tags
 *   "all:tag-a,tag-b"     has ALL of these tags
 * plus an optional exclude list "tag-c,tag-d" (has none of these).
 */
export function parseAudience(audience: string, exclude = ""): Segment {
  const a = audience.trim();
  if (!a) throw new Error('audience is required ("*" for everyone)');
  const tags = (s: string) =>
    s
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const n = normalizeTag(t);
        if (!n || n !== t.toLowerCase()) throw new Error(`invalid tag "${t}"`);
        return n;
      });
  const match: Segment["match"] = a.toLowerCase().startsWith("all:") ? "all" : "any";
  const body = match === "all" ? a.slice(4) : a;
  const include = body === "*" ? [] : tags(body);
  if (body !== "*" && !include.length) throw new Error("audience has no tags");
  return { include_tags: include, exclude_tags: tags(exclude), match };
}

export function describeSegment(s: Partial<Segment>): string {
  const inc = s.include_tags ?? [];
  const exc = s.exclude_tags ?? [];
  const head = inc.length ? `${s.match === "all" ? "all of" : "any of"}: ${inc.join(", ")}` : "everyone subscribed";
  return exc.length ? `${head} · excluding ${exc.join(", ")}` : head;
}

/**
 * SQL predicate over contact alias `c` for a segment. Placeholders: include (text[]),
 * exclude (text[]), matchAll (boolean). Shared by audience counts and broadcast materialization
 * so the preview count is exactly who gets the email.
 */
export function segmentPredicate(inc: string, exc: string, all: string): string {
  return `(
    cardinality(${inc}::text[]) = 0
    or (${all}::boolean and (select count(distinct t.name) from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id
                             where ct.contact_id = c.id and t.name = any(${inc}::text[])) = cardinality(${inc}::text[]))
    or (not ${all}::boolean and exists (select 1 from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id
                             where ct.contact_id = c.id and t.name = any(${inc}::text[])))
  )
  and not exists (select 1 from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id
                   where ct.contact_id = c.id and t.name = any(${exc}::text[]))`;
}

export function segmentParams(s: Partial<Segment>): [string, string, boolean] {
  return [pgArray((s.include_tags ?? []).map(String)), pgArray((s.exclude_tags ?? []).map(String)), s.match === "all"];
}

export interface AudienceCounts {
  /** subscribed contacts that match: these get the email */
  recipients: number;
  /** matching contacts that are unsubscribed / bounced / complained (never emailed) */
  suppressed: number;
  /** all subscribed contacts in the brand */
  subscribedTotal: number;
  /** tags in the filter that don't exist in this brand (typo check) */
  unknownTags: string[];
}

export async function audienceCounts(db: Db, brandId: string, s: Segment): Promise<AudienceCounts> {
  const [inc, exc, all] = segmentParams(s);
  const [r] = await db.query<{ recipients: number; suppressed: number; subscribed_total: number }>(
    `select
       count(*) filter (where c.status = 'subscribed' and ${segmentPredicate("$2", "$3", "$4")})::int as recipients,
       count(*) filter (where c.status <> 'subscribed' and ${segmentPredicate("$2", "$3", "$4")})::int as suppressed,
       count(*) filter (where c.status = 'subscribed')::int as subscribed_total
     from email_boss.contacts c where c.brand_id = $1`,
    [brandId, inc, exc, all],
  );
  const wanted = [...s.include_tags, ...s.exclude_tags];
  const known = wanted.length
    ? await db.query<{ name: string }>(`select name from email_boss.tags where brand_id = $1 and name = any($2::text[])`, [brandId, pgArray(wanted)])
    : [];
  const knownSet = new Set(known.map((k) => k.name));
  return {
    recipients: r.recipients,
    suppressed: r.suppressed,
    subscribedTotal: r.subscribed_total,
    unknownTags: wanted.filter((t) => !knownSet.has(t)),
  };
}

export async function createBroadcast(
  db: Db,
  opts: { brandId: string; name: string; templateId: string; subject?: string | null; segment: Segment; scheduledAt: Date | null },
): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `insert into email_boss.broadcasts (brand_id, name, template_id, subject_override, segment, status, scheduled_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz) returning id`,
    [opts.brandId, opts.name, opts.templateId, opts.subject ?? null, JSON.stringify(opts.segment),
      opts.scheduledAt ? "scheduled" : "draft", opts.scheduledAt?.toISOString() ?? null],
  );
  return row.id;
}
