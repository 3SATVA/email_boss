import { pgArray, type Db } from "../db";
import { addMinutes } from "./schedule";
import { normalizeEmail, normalizeTag, type ContactStatus } from "./types";

export interface SubscribeInput {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  tags?: string[];
  source?: string | null;
  custom_fields?: Record<string, unknown>;
  /** the person explicitly opted in just now (form submit). Needed to re-subscribe someone. */
  consent?: boolean;
  consent_ip?: string | null;
  /** keys of `manual`-trigger sequences to enroll into */
  enroll?: string[];
}

export interface SubscribeResult {
  contactId: string;
  status: ContactStatus;
  created: boolean;
  resubscribed: boolean;
  tagsAdded: string[];
  enrolled: string[];
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function cleanName(v: string | null | undefined): string | null {
  const s = (v ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, 100);
  return s || null;
}

/**
 * Create or update a contact in ONE brand, add tags, and enroll into any of that brand's
 * active sequences whose trigger matches. Never touches another brand.
 */
export async function subscribeContact(
  db: Db,
  brandId: string,
  input: SubscribeInput,
  now: Date = new Date(),
): Promise<SubscribeResult> {
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("invalid email");
  const tags = [...new Set((input.tags ?? []).map(normalizeTag))];
  if (tags.some((t) => t === null)) throw new ValidationError("invalid tag (use lowercase letters, digits, _ : . / -)");
  const source = input.source ? String(input.source).trim().slice(0, 100) : null;
  const custom = input.custom_fields ?? {};
  const ip = input.consent_ip && /^[0-9a-fA-F:.]{3,45}$/.test(input.consent_ip) ? input.consent_ip : null;
  const nowIso = now.toISOString();

  return db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string; status: ContactStatus }>(
      `select id, status from email_boss.contacts where brand_id = $1 and email = $2 for update`,
      [brandId, email],
    );

    let contactId: string;
    let status: ContactStatus;
    let created = false;
    let resubscribed = false;

    if (!existing.length) {
      const rows = await tx.query<{ id: string }>(
        `insert into email_boss.contacts
           (brand_id, email, first_name, last_name, status, source, custom_fields,
            consent_at, consent_ip, consent_source, status_changed_at, created_at)
         values ($1, $2, $3, $4, 'subscribed', $5, $6::jsonb, $10::timestamptz, $8::inet, $9, $7::timestamptz, $7::timestamptz)
         returning id`,
        [brandId, email, cleanName(input.first_name), cleanName(input.last_name), source, JSON.stringify(custom),
          nowIso, ip, source ? `form:${source}` : "api", input.consent === false ? null : nowIso],
      );
      contactId = rows[0].id;
      status = "subscribed";
      created = true;
      await tx.query(
        `insert into email_boss.events (brand_id, contact_id, type, occurred_at, data) values ($1, $2, 'subscribe', $3::timestamptz, $4::jsonb)`,
        [brandId, contactId, nowIso, JSON.stringify({ source })],
      );
    } else {
      contactId = existing[0].id;
      status = existing[0].status;
      // Only an explicit new opt-in lifts an unsubscribe. Bounced / complained stay suppressed forever.
      if (status === "unsubscribed" && input.consent === true) {
        status = "subscribed";
        resubscribed = true;
      }
      await tx.query(
        `update email_boss.contacts set
           first_name = coalesce($3, first_name),
           last_name = coalesce($4, last_name),
           custom_fields = custom_fields || $5::jsonb,
           source = coalesce(source, $6),
           status = $7,
           status_changed_at = case when $8::boolean then $9::timestamptz else status_changed_at end,
           consent_at = case when $8::boolean then $9::timestamptz else consent_at end,
           consent_ip = case when $8::boolean then $10::inet else consent_ip end
         where id = $1 and brand_id = $2`,
        [contactId, brandId, cleanName(input.first_name), cleanName(input.last_name), JSON.stringify(custom), source,
          status, resubscribed, nowIso, ip],
      );
      if (resubscribed) {
        await tx.query(
          `insert into email_boss.events (brand_id, contact_id, type, occurred_at, data) values ($1, $2, 'resubscribe', $3::timestamptz, $4::jsonb)`,
          [brandId, contactId, nowIso, JSON.stringify({ source })],
        );
      }
    }

    const tagsAdded = await addTags(tx, brandId, contactId, tags as string[], now);

    const enrolled: string[] = [];
    if (status === "subscribed") {
      const seqs = await tx.query<{ id: string; key: string }>(
        `select id, key from email_boss.sequences
          where brand_id = $1 and status = 'active' and (
            (trigger_type = 'tag_added' and trigger_config->>'tag' = any($2::text[]))
            or ($3::boolean and trigger_type = 'signup_source' and trigger_config->>'source' = $4)
            or (trigger_type = 'manual' and key = any($5::text[]))
          )
          order by key`,
        [brandId, pgArray(tagsAdded), created || resubscribed, source ?? "", pgArray(input.enroll ?? [])],
      );
      for (const s of seqs) {
        if (await enrollContact(tx, { brandId, sequenceId: s.id, contactId, now })) enrolled.push(s.key);
      }
    }

    return { contactId, status, created, resubscribed, tagsAdded, enrolled };
  });
}

/** Add tags (creating them in this brand if needed). Returns the tags that were newly added. */
export async function addTags(db: Db, brandId: string, contactId: string, tags: string[], now = new Date()): Promise<string[]> {
  if (!tags.length) return [];
  await db.query(
    `insert into email_boss.tags (brand_id, name) select $1, unnest($2::text[]) on conflict (brand_id, name) do nothing`,
    [brandId, pgArray(tags)],
  );
  const rows = await db.query<{ name: string }>(
    `with ins as (
       insert into email_boss.contact_tags (contact_id, tag_id, brand_id, added_at)
       select $2, t.id, $1, $4::timestamptz from email_boss.tags t where t.brand_id = $1 and t.name = any($3::text[])
       on conflict do nothing
       returning tag_id
     )
     select t.name from ins join email_boss.tags t on t.id = ins.tag_id order by t.name`,
    [brandId, contactId, pgArray(tags), now.toISOString()],
  );
  return rows.map((r) => r.name);
}

/**
 * Enroll a contact into a sequence (same brand enforced by composite FKs).
 * Returns the enrollment id, or null if already enrolled / not eligible.
 */
export async function enrollContact(
  db: Db,
  opts: { brandId: string; sequenceId: string; contactId: string; now?: Date; cycleKey?: string },
): Promise<string | null> {
  const now = opts.now ?? new Date();
  const first = await db.query<{ delay_minutes: number; allow_reenroll: boolean }>(
    `select st.delay_minutes, s.allow_reenroll
       from email_boss.sequences s
       join email_boss.sequence_steps st on st.sequence_id = s.id and st.position = 0
      where s.id = $1 and s.brand_id = $2`,
    [opts.sequenceId, opts.brandId],
  );
  if (!first.length) return null;
  const nextRunAt = addMinutes(now, first[0].delay_minutes).toISOString();
  const cycle = opts.cycleKey ?? "";
  const insert = (cycleKey: string) =>
    db.query<{ id: string }>(
      `insert into email_boss.enrollments (brand_id, sequence_id, contact_id, cycle_key, status, current_position, next_run_at, enrolled_at)
       values ($1, $2, $3, $4, 'active', 0, $5::timestamptz, $6::timestamptz)
       on conflict (sequence_id, contact_id, cycle_key) do nothing
       returning id`,
      [opts.brandId, opts.sequenceId, opts.contactId, cycleKey, nextRunAt, now.toISOString()],
    );
  const rows = await insert(cycle);
  if (rows.length) return rows[0].id;
  if (!first[0].allow_reenroll) return null;
  // Re-enroll only if no enrollment of this contact in this sequence is still running.
  const active = await db.query(
    `select 1 from email_boss.enrollments where sequence_id = $1 and contact_id = $2 and status in ('active', 'paused') limit 1`,
    [opts.sequenceId, opts.contactId],
  );
  if (active.length) return null;
  const again = await insert(`${cycle}re:${now.toISOString()}`);
  return again[0]?.id ?? null;
}

const SUPPRESS_EVENT: Record<Exclude<ContactStatus, "subscribed">, string> = {
  unsubscribed: "unsubscribe",
  bounced: "bounce",
  complained: "complaint",
};

/**
 * Move a contact to a suppressed status (never to a "less suppressed" one), exit its
 * running enrollments and cancel its queued sends. Scoped to (contactId, brandId).
 */
export async function suppressContact(
  db: Db,
  opts: {
    contactId: string;
    brandId: string;
    status: Exclude<ContactStatus, "subscribed">;
    now?: Date;
    data?: Record<string, unknown>;
    sendId?: string | null;
    providerEventId?: string | null;
  },
): Promise<{ changed: boolean; found: boolean }> {
  const now = (opts.now ?? new Date()).toISOString();
  return db.transaction(async (tx) => {
    const found = await tx.query<{ status: ContactStatus }>(
      `select status from email_boss.contacts where id = $1 and brand_id = $2 for update`,
      [opts.contactId, opts.brandId],
    );
    if (!found.length) return { changed: false, found: false };
    const ev = await tx.query(
      `insert into email_boss.events (brand_id, contact_id, send_id, type, occurred_at, data, provider_event_id)
       values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb, $7)
       on conflict (provider_event_id) do nothing returning id`,
      [opts.brandId, opts.contactId, opts.sendId ?? null, SUPPRESS_EVENT[opts.status], now,
        JSON.stringify(opts.data ?? {}), opts.providerEventId ?? null],
    );
    if (!ev.length) return { changed: false, found: true }; // duplicate webhook delivery
    const upd = await tx.query(
      `update email_boss.contacts set status = $3, status_changed_at = $4::timestamptz
        where id = $1 and brand_id = $2 and email_boss.status_rank(status) < email_boss.status_rank($3)
        returning id`,
      [opts.contactId, opts.brandId, opts.status, now],
    );
    await tx.query(
      `update email_boss.enrollments set status = 'exited', exit_reason = $3, next_run_at = null
        where contact_id = $1 and brand_id = $2 and status in ('active', 'paused')`,
      [opts.contactId, opts.brandId, `contact_${opts.status}`],
    );
    await tx.query(
      `update email_boss.sends set status = 'canceled', error = $3
        where contact_id = $1 and brand_id = $2 and status = 'queued'`,
      [opts.contactId, opts.brandId, `contact_${opts.status}`],
    );
    return { changed: upd.length > 0, found: true };
  });
}
