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
  format: ImportFormat;
  rows: number;
  valid: number;
  invalid: { row: number; value: string }[];
  duplicatesMerged: number;
  skippedPending: number;
  /** subscribed per file but with no email permission (e.g. Constant Contact "Not set") -> imported as unsubscribed */
  noPermission: number;
  unknownStatuses: Record<string, number>;
  byStatus: Record<ContactStatus, number>;
  withConsentDate: number;
  tagCounts: Record<string, number>;
  columns: DetectedColumns;
}

export type ImportFormat = "auto" | "systeme" | "constant_contact";

export interface DetectedColumns {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  /** every status-like column; the most suppressed value across them wins */
  status: string[];
  /** every tag/list column; values are unioned */
  tags: string[];
  consent_at: string | null;
  /** a non-empty opt-out date means unsubscribed */
  optout_at: string | null;
}

const ALIASES: Record<keyof DetectedColumns, string[]> = {
  email: ["email", "emailaddress", "e-mail", "email_address", "mail", "emailaddr", "subscriberemail", "contactemail"],
  first_name: ["firstname", "first", "givenname", "fname", "first_name", "prenom", "name"],
  last_name: ["lastname", "last", "surname", "familyname", "lname", "last_name"],
  status: ["emailstatus", "status", "emailpermissionstatus", "emailpermission", "permissionstatus", "subscriptionstatus", "subscribed",
    "emailmarketingstatus", "optinstatus", "emailsubscriptionstatus", "consentstatus",
    "unsubscribed", "isunsubscribed", "optedout", "optout", "donotemail"],
  tags: ["tags", "tag", "lists", "emaillists", "listmembership", "listmemberships", "list", "segments", "groups"],
  consent_at: ["emailopt-indate", "emailoptindate", "consentdate", "optindate", "optintime", "signupdate", "dateregistered", "dateadded",
    "createdat", "created", "subscribedat", "emailaddedat", "datesubscribed", "registeredat", "registrationdate"],
  optout_at: ["emailopt-outdate", "emailoptoutdate", "optoutdate", "unsubscribedat", "unsubscribedate", "dateunsubscribed"],
};

/** Known export layouts. systeme.io: Email, First name, Last name, ..., Tag, Date Registered. */
const PRESETS: Record<Exclude<ImportFormat, "auto">, Partial<Record<keyof DetectedColumns, string[]>>> = {
  systeme: { email: ["Email"], first_name: ["First name"], last_name: ["Last name"], tags: ["Tag"], consent_at: ["Date Registered"] },
  constant_contact: {
    email: ["Email address", "Email Address", "Email"],
    first_name: ["First name", "First Name"],
    last_name: ["Last name", "Last Name"],
    status: ["Email permission status", "Email Permission Status", "Email status", "Email Status"],
    tags: ["Email Lists", "List Memberships", "Lists", "Tags"],
    consent_at: ["Email Opt-in Date", "Email opt-in date", "Created At", "Created at", "Date added"],
    optout_at: ["Email Opt-out Date", "Email opt-out date"],
  },
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9_-]/g, "");

export function detectFormat(headers: string[]): Exclude<ImportFormat, "auto"> | null {
  const h = new Set(headers.map(norm));
  if (h.has("email") && h.has("dateregistered") && h.has("tag")) return "systeme";
  if (h.has("emailaddress") && (h.has("emailpermissionstatus") || h.has("emailstatus") || h.has("emaillists"))) return "constant_contact";
  return null;
}

export function detectColumns(headers: string[], overrides: Record<string, string> = {}, format: ImportFormat = "auto"): DetectedColumns {
  const fmt = format === "auto" ? detectFormat(headers) : format;
  const preset = fmt ? PRESETS[fmt] : {};
  const find = (names: string[]) => names.map((a) => headers.find((h) => h === a) ?? headers.find((h) => norm(h) === norm(a))).filter(Boolean) as string[];
  const pick = (field: keyof DetectedColumns): string[] => {
    if (overrides[field]) {
      const cols = overrides[field].split("|");
      for (const c of cols) if (!headers.includes(c)) throw new Error(`column "${c}" not found for ${field}`);
      return cols;
    }
    const fromPreset = find(preset[field] ?? []);
    return [...new Set([...fromPreset, ...find(ALIASES[field])])];
  };
  return {
    email: pick("email")[0] ?? null,
    first_name: pick("first_name")[0] ?? null,
    last_name: pick("last_name")[0] ?? null,
    status: pick("status"),
    tags: pick("tags"),
    consent_at: pick("consent_at")[0] ?? null,
    optout_at: pick("optout_at")[0] ?? null,
  };
}

export type MappedStatus = ContactStatus | "pending" | "no_permission" | { unknown: string };

export function mapStatus(raw: string | undefined, column: string | null): MappedStatus {
  const v = (raw ?? "").trim().toLowerCase();
  // Inverted boolean columns ("Unsubscribed: yes", "Opted out: true", "Do not email: 1").
  if (column && /unsub|optedout|optout|donotemail/.test(norm(column))) {
    if (/^(yes|y|true|1|x)$/.test(v)) return "unsubscribed";
    if (!v || /^(no|n|false|0)$/.test(v)) return "subscribed";
  }
  if (!v) return "subscribed";
  if (/complain|spam|abuse/.test(v)) return "complained";
  if (/bounce|invalid|undeliverable|non.?deliverable|hard/.test(v)) return "bounced";
  if (/unsub|opt.?out|opted.?out|removed|do.?not|suppress|blocked|cleaned|deleted|inactive/.test(v)) return "unsubscribed";
  if (/^(not.?set|no.?permission|none|never.?subscribed|no.?consent|non.?subscriber)$/.test(v)) return "no_permission";
  if (/pending|unconfirmed|awaiting|not.?confirmed/.test(v)) return "pending";
  if (/^(subscribed|active|yes|y|true|1|confirmed|opted.?in|explicit|implicit|permitted|ok|valid|deliverable)$/.test(v)) return "subscribed";
  if (column && /^subscribed$/i.test(norm(column)) && /^(no|n|false|0)$/.test(v)) return "unsubscribed";
  return { unknown: v };
}

const RANK: Record<ContactStatus, number> = { subscribed: 0, unsubscribed: 1, bounced: 2, complained: 3 };
const worse = (a: ContactStatus, b: ContactStatus) => (RANK[a] >= RANK[b] ? a : b);

/**
 * Dates: ISO, "2026-02-16 18:26:17 (UTC-8)" (systeme.io), "2026-02-16 18:26:17 -0800",
 * "10/21/2026 13:05" (read as UTC when there's no zone). Returns ISO or null.
 */
export function parseDate(v: string | undefined): string | null {
  const s = v?.trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*\((?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\)$/i.exec(s);
  if (m) {
    const off = `${m[3]}${m[4].padStart(2, "0")}:${m[5] ?? "00"}`;
    const t = Date.parse(`${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}${off}`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const z = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (z) {
    const t = Date.parse(`${z[1]}T${z[2]}Z`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (us) {
    const t = Date.UTC(+us[3], +us[1] - 1, +us[2], +(us[4] ?? 0), +(us[5] ?? 0), +(us[6] ?? 0));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const toKey = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);

export interface ParseOptions {
  columns?: Record<string, string>;
  format?: ImportFormat;
  extraTags?: string[];
  keepCustom?: boolean;
  /** contacts carrying any of these tags are imported as unsubscribed */
  suppressTags?: string[];
}

export function parseContactsCsv(text: string, opts: ParseOptions = {}): { contacts: ImportedContact[]; stats: ImportStats } {
  const records = parse(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: false }) as Record<string, string>[];
  const headers = records.length ? Object.keys(records[0]) : [];
  const format: ImportFormat = opts.format && opts.format !== "auto" ? opts.format : (detectFormat(headers) ?? "auto");
  const cols = detectColumns(headers, opts.columns, format);
  if (!cols.email) throw new Error(`no email column found (headers: ${headers.join(", ")}); pass --map email=<column>`);
  const used = new Set([cols.email, cols.first_name, cols.last_name, cols.consent_at, cols.optout_at, ...cols.status, ...cols.tags].filter(Boolean) as string[]);
  const tagOrThrow = (t: string) => {
    const n = normalizeTag(t);
    if (!n) throw new Error(`invalid tag ${t}`);
    return n;
  };
  const extra = (opts.extraTags ?? []).map(tagOrThrow);
  const suppressTags = new Set((opts.suppressTags ?? []).map(tagOrThrow));

  const stats: ImportStats = {
    format, rows: records.length, valid: 0, invalid: [], duplicatesMerged: 0, skippedPending: 0, noPermission: 0, unknownStatuses: {},
    byStatus: { subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 }, withConsentDate: 0, tagCounts: {}, columns: cols,
  };
  const byEmail = new Map<string, ImportedContact>();

  records.forEach((r, i) => {
    const email = normalizeEmail(r[cols.email!] ?? "");
    if (!email) {
      stats.invalid.push({ row: i + 2, value: String(r[cols.email!] ?? "").slice(0, 80) });
      return;
    }
    let status: ContactStatus = "subscribed";
    let pending = false;
    let noPerm = false;
    for (const col of cols.status) {
      const m = mapStatus(r[col], col);
      if (m === "pending") pending = true;
      else if (m === "no_permission") noPerm = true;
      else if (typeof m === "object") {
        stats.unknownStatuses[m.unknown] = (stats.unknownStatuses[m.unknown] ?? 0) + 1;
        status = worse(status, "unsubscribed");
      } else status = worse(status, m);
    }
    if (cols.optout_at && (r[cols.optout_at] ?? "").trim()) status = worse(status, "unsubscribed");
    if (status === "subscribed" && noPerm) {
      stats.noPermission++;
      status = "unsubscribed";
    }
    if (status === "subscribed" && pending) {
      stats.skippedPending++;
      return;
    }
    const tags = new Set(extra);
    for (const col of cols.tags) {
      for (const t of (r[col] ?? "").split(/[,;|]/)) {
        const n = normalizeTag(t);
        if (n) tags.add(n);
      }
    }
    if ([...tags].some((t) => suppressTags.has(t))) status = worse(status, "unsubscribed");
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
      status,
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
  for (const c of contacts) {
    stats.byStatus[c.status]++;
    if (c.consent_at) stats.withConsentDate++;
    for (const t of c.tags) stats.tagCounts[t] = (stats.tagCounts[t] ?? 0) + 1;
  }
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
