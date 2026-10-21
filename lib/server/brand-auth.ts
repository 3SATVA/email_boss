import type { Db } from "../db";
import type { BrandRow } from "../engine/types";
import { apiKeyMatches, slugFromApiKey } from "../tokens";

/** Resolve the brand for a brand-scoped API key (eb_<slug>_<secret>). null = unauthorized. */
export async function authenticateBrand(db: Db, key: string | null | undefined): Promise<BrandRow | null> {
  if (!key) return null;
  const slug = slugFromApiKey(key.trim());
  if (!slug) return null;
  const rows = await db.query<BrandRow>(`select * from email_boss.brands where slug = $1`, [slug]);
  const brand = rows[0];
  if (!brand || !apiKeyMatches(key.trim(), brand.api_key_hash)) return null;
  return brand;
}

export function bearer(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return headers.get("x-api-key");
}

export function clientIp(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers.get("x-real-ip") || null;
}
