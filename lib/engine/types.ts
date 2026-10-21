export type ContactStatus = "subscribed" | "unsubscribed" | "bounced" | "complained";

export interface BrandRow {
  id: string;
  slug: string;
  name: string;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  sending_domain: string;
  physical_address: string;
  timezone: string;
  provider: string | null;
  ses_configuration_set: string | null;
  links_base_url: string | null;
  status: "active" | "paused";
  warmup_started_on: string | Date | null;
  daily_cap_override: number | null;
  api_key_hash: string | null;
}

export interface ContactRow {
  id: string;
  brand_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: ContactStatus;
  source: string | null;
  custom_fields: Record<string, unknown>;
}

export const S = "email_boss"; // schema name used in SQL

export function normalizeEmail(raw: string): string | null {
  const e = String(raw ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  if (e.length < 3 || e.length > 254) return null;
  if (!/^[^@\s"'<>(),;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(e)) return null;
  if (e.split("@")[0].length > 64) return null;
  return e;
}

export function normalizeTag(raw: string): string | null {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_:./-]/g, "");
  return /^[a-z0-9][a-z0-9_:./-]{0,79}$/.test(t) ? t : null;
}
