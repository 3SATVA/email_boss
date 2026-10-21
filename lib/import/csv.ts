import { parse } from "csv-parse/sync";
import { pgArray, type Db } from "../db";
import { normalizeEmail, normalizeTag, type ContactStatus } from "../engine/types";

/**
 * CSV list import (Constant Contact, systeme.io, Mailchimp, generic exports).
 *
 * Safety rules:
 *  - emails are trimmed + lowercased + validated; invalid rows are reported, not imported
 *  - duplicates are merged (tags unioned, the MOST suppressed status wins)
 *  - unsubscribed / bounced / complained rows are imported as suppressed contacts so they
 *    can never be emailed by accident; bounced is never imported as active
 *  - "pending"/unconfirmed rows are skipped (they never confirmed consent)
 *  - unknown status values are treated as unsubscribed (safe default) and reported
 *  - an existing contact is never moved to a less suppressed status by an import
 */

export interface ImportedContact {
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: ContactStatus;
  tags: string[];
  custom_fields: Record<string, string>;
  consent_at: string | null;
}

export interface ImportStats {
  rows: number;
  valid: number;
  invalid: { row: number; value: string }[];
  duplicatesMerged: number;
  skippedPending: number;
  unknownStatuses: Record<string, number>;
  byStatus: Record<ContactStatus, number>;
  columns: Record<string, string | null>;
}

const ALIASES: Record<string, string[]> = {
  email: ["email", "emailaddress", "e-mail", "email_address", "mail", "emailaddr", "subscriberemail", "contactemail"],
  first_name: ["firstname", "first", "givenname", "fname", "first_name", "prenom", "name"],
  last_name: ["lastname", "last", "surname", "familyname", "lname", "last_name"],
  status: ["emailstatus", "status", "emailpermissionstatus", "permissionstatus", "subscriptionstatus", "subscribed",
    "emailmarketingstatus", "optinstatus", "emailsubscriptionstatus", "consentstatus",
    "unsubscribed", "isunsubscribed", "optedout", "optout", "donotemail"],
  tags: ["tags", "tag", "lists", "emaillists", "listmembership", "list", "segments", "groups"],
  consent_at: ["consentdate", "optindate", "optintime", "signupdate", "dateadded", "createdat", "created", "subscribedat",
    "emailaddedat", "datesubscribed", "registeredat", "registrationdate"],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9_-]/g, "");

export function detectColumns(headers: string[], overrides: Record<string, string> = {}): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of Object.keys(ALIASES)) {
    if (overrides[field]) {
      if (!headers.includes(overrides[field])) throw new Error(`column "${overrides[field]}" not found for ${field}`);
      out[field] = overrides[field];
      continue;
    }
    const hit = ALIASES[field].map((a) => headers.find((h) => norm(h) === norm(a))).find(Boolean);
    out[field] = hit ?? null;
  }
  // a single "name" column is only used for first_name when there's no first-name column
  return out;
}

export function mapStatus(raw: string | undefined, column: string | null): ContactStatus | "pending" | { unknown: string } {
  const v = (raw ?? "").trim().toLowerCase();
  // Inverted boolean columns ("Unsubscribed: yes", "Opted out: true", "Do not email: 1").
  if (column && /unsub|optedout|optout|donotemail/.test(norm(column))) {
    if (/^(yes|y|true|1|x)$/.test(v)) return "unsubscribed";
    if (!v || /^(no|n|false|0)$/.test(v)) return "subscribed";
  }
  if (!v) return "subscribed";
  if (/complain|spam|abuse/.test(v)) return "complained";
  if (/bounce|invalid|undeliverable|non.?deliverable|hard/.test(v)) return "bounced";
  if (/unsub|opt.?out|opted.?out|removed|do.?not|suppress|blocked|cleaned|deleted|inactive|unconfirmed.?unsub/.test(v)) return "unsubscribed";
  if (/pending|unconfirmed|awaiting|not.?confirmed/.test(v)) return "pending";
  if (/^(subscribed|active|yes|y|true|1|confirmed|opted.?in|explicit|implicit|permitted|ok|valid|deliverable)$/.test(v)) return "subscribed";
  if (column && /^subscribed$/i.test(norm(column)) && /^(no|n|false|0)$/.test(v)) return "unsubscribed";
  return { unknown: v };
}

const RANK: Record<ContactStatus, number> = { subscribed: 0, unsubscribed: 1, bounced: 2, complained: 3 };
const worse = (a: ContactStatus, b: ContactStatus) => (RANK[a] >= RANK[b] ? a : b);

function parseDate(v: string | undefined): string | null {
  if (!v?.trim()) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const toKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

export function parseContactsCsv(
  text: string,
  opts: { columns?: Record<string, string>; extraTags?: string[]; keepCustom?: boolean } = {},
): { contacts: ImportedContact[]; stats: ImportStats } {
  const records = parse(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: false }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : [];
  const cols = detectColumns(headers, opts.columns);
  if (!cols.email) throw new Error(`no email column found (headers: ${headers.join(", ")}); pass --map email=<column>`);
  const used = new Set(Object.values(cols).filter(Boolean) as string[]);
  const extra = (opts.extraTags ?? []).map((t) => {
    const n = normalizeTag(t);
    if (!n) throw new Error(`invalid tag ${t}`);
    return n;
  });

  const stats: ImportStats = {
    rows: records.length, valid: 0, invalid: [], duplicatesMerged: 0, skippedPending: 0, unknownStatuses: {},
    byStatus: { subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 }, columns: cols,
  };
  const byEmail = new Map<string, ImportedContact>();

  records.forEach((r, i) => {
    const email = normalizeEmail(r[cols.email!] ?? "");
    if (!email) {
      stats.invalid.push({ row: i + 2, value: String(r[cols.email!] ?? "").slice(0, 80) });
      return;
    }
    let mapped = mapStatus(cols.status ? r[cols.status] : undefined, cols.status);
    if (mapped === "pending") {
      stats.skippedPending++;
      return;
    }
    if (typeof mapped === "object") {
      stats.unknownStatuses[mapped.unknown] = (stats.unknownStatuses[mapped.unknown] ?? 0) + 1;
      mapped = "unsubscribed";
    }
    const tags = new Set(extra);
    if (cols.tags && r[cols.tags]) {
      for (const t of r[cols.tags].split(/[,;|]/)) {
        const n = normalizeTag(t);
        if (n) tags.add(n);
      }
    }
    const custom: Record<string, string> = {};
    if (opts.keepCustom !== false) {
      for (const h of headers) {
        if (used.has(h)) continue;
        const v = (r[h] ?? "").trim();
        const k = toKey(h);
        if (v && k) custom[k] = v.slice(0, 500);
      }
    }
    const c: ImportedContact = {
      email,
      first_name: (cols.first_name ? r[cols.first_name]?.trim() : "") || null,
      last_name: (cols.last_name ? r[cols.last_name]?.trim() : "") || null,
      status: mapped,
      tags: [...tags],
      custom_fields: custom,
      consent_at: parseDate(cols.consent_at ? r[cols.consent_at] : undefined),
    };
    const prev = byEmail.get(email);
    if (prev) {
      stats.duplicatesMerged++;
      prev.status = worse(prev.status, c.status);
      prev.first_name ??= c.first_name;
      prev.last_name ??= c.last_name;
      prev.tags = [...new Set([...prev.tags, ...c.tags])];
      prev.custom_fields = { ...c.custom_fields, ...prev.custom_fields };
      prev.consent_at ??= c.consent_at;
    } else {
      byEmail.set(email, c);
    }
  });

  const contacts = [...byEmail.values()];
  stats.valid = contacts.length;
  for (const c of contacts) stats.byStatus[c.status]++;
  return { contacts, stats };
}

/**
 * Upsert parsed contacts into ONE brand, in batches. Imports never trigger sequences.
 * Returns how many rows were inserted vs updated.
 */
export async function importContacts(
  db: Db,
  brandId: string,
  contacts: ImportedContact[],
  opts: { source: string; now?: Date; batchSize?: number },
): Promise<{ inserted: number; updated: number }> {
  const now = (opts.now ?? new Date()).toISOString();
  let inserted = 0;
  let updated = 0;
  const size = opts.batchSize ?? 500;
  for (let i = 0; i < contacts.length; i += size) {
    const batch = contacts.slice(i, i + size);
    await db.transaction(async (tx) => {
      const rows = await tx.query<{ inserted: boolean }>(
        `insert into email_boss.contacts as c
           (brand_id, email, first_name, last_name, status, source, custom_fields, consent_at, consent_source, status_changed_at, created_at)
         select $1, x.email, x.first_name, x.last_name, x.status, $2, coalesce(x.custom_fields, '{}'::jsonb),
                x.consent_at, $3, $4::timestamptz, $4::timestamptz
           from jsonb_to_recordset($5::jsonb) as x(email text, first_name text, last_name text, status text,
                                                   custom_fields jsonb, consent_at timestamptz)
         on conflict (brand_id, email) do update set
           first_name = coalesce(c.first_name, excluded.first_name),
           last_name = coalesce(c.last_name, excluded.last_name),
           custom_fields = excluded.custom_fields || c.custom_fields,
           consent_at = coalesce(c.consent_at, excluded.consent_at),
           status = case when email_boss.status_rank(excluded.status) > email_boss.status_rank(c.status)
                         then excluded.status else c.status end,
           status_changed_at = case when email_boss.status_rank(excluded.status) > email_boss.status_rank(c.status)
                         then excluded.status_changed_at else c.status_changed_at end
         returning (xmax = 0) as inserted`,
        [brandId, opts.source, `import:${opts.source}`, now,
          JSON.stringify(batch.map(({ tags: _t, ...rest }) => rest))],
      );
      for (const r of rows) r.inserted ? inserted++ : updated++;

      const pairs = batch.flatMap((c) => c.tags.map((t) => ({ email: c.email, tag: t })));
      if (pairs.length) {
        await tx.query(
          `insert into email_boss.tags (brand_id, name) select $1, unnest($2::text[]) on conflict (brand_id, name) do nothing`,
          [brandId, pgArray([...new Set(pairs.map((p) => p.tag))])],
        );
        await tx.query(
          `insert into email_boss.contact_tags (contact_id, tag_id, brand_id, added_at)
           select c.id, t.id, $1, $3::timestamptz
             from jsonb_to_recordset($2::jsonb) as x(email text, tag text)
             join email_boss.contacts c on c.brand_id = $1 and c.email = x.email
             join email_boss.tags t on t.brand_id = $1 and t.name = x.tag
           on conflict do nothing`,
          [brandId, JSON.stringify(pairs), now],
        );
      }
    });
  }
  return { inserted, updated };
}
