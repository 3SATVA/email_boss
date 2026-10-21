import crypto from "node:crypto";

/**
 * Signed unsubscribe tokens:  v1.<contactId>.<brandId>.<hmac>
 *
 * - HMAC-SHA256 over "v1.<contactId>.<brandId>" with UNSUBSCRIBE_SECRET, base64url.
 * - No expiry on purpose: CAN-SPAM requires unsubscribe links to keep working for at
 *   least 30 days after sending, and old emails get opened years later.
 * - Rotation: put the old secret in UNSUBSCRIBE_SECRET_PREVIOUS while links signed with
 *   it are still in inboxes.
 * - The token is bound to one contact in one brand; it can never affect another brand.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mac(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signUnsubscribeToken(contactId: string, brandId: string, secret: string): string {
  if (!secret || secret.length < 16) throw new Error("UNSUBSCRIBE_SECRET must be at least 16 characters");
  if (!UUID.test(contactId) || !UUID.test(brandId)) throw new Error("contactId and brandId must be uuids");
  const payload = `v1.${contactId}.${brandId}`;
  return `${payload}.${mac(secret, payload)}`;
}

export function verifyUnsubscribeToken(
  token: string | null | undefined,
  secrets: Array<string | undefined>,
): { contactId: string; brandId: string } | null {
  if (!token || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, contactId, brandId, sig] = parts;
  if (!UUID.test(contactId) || !UUID.test(brandId)) return null;
  const payload = `v1.${contactId}.${brandId}`;
  const given = Buffer.from(sig, "base64url");
  for (const secret of secrets) {
    if (!secret) continue;
    const expected = Buffer.from(mac(secret, payload), "base64url");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      return { contactId, brandId };
    }
  }
  return null;
}

export function unsubscribeSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.UNSUBSCRIBE_SECRET, env.UNSUBSCRIBE_SECRET_PREVIOUS].filter((s): s is string => Boolean(s));
}

export function requireUnsubscribeSecret(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.UNSUBSCRIBE_SECRET;
  if (!s || s.length < 16) throw new Error("UNSUBSCRIBE_SECRET is not set (min 16 chars)");
  return s;
}

export function unsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/unsubscribe?t=${encodeURIComponent(token)}`;
}

/** RFC 8058 one-click endpoint (the List-Unsubscribe header target). */
export function oneClickUnsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/unsubscribe?t=${encodeURIComponent(token)}`;
}

// ---------------------------------------------------------------------------
// brand API keys:  eb_<slug>_<random>; only a sha256 hash is stored in brands.api_key_hash
// ---------------------------------------------------------------------------
export function generateBrandApiKey(slug: string): { key: string; hash: string } {
  const key = `eb_${slug}_${crypto.randomBytes(24).toString("base64url")}`;
  return { key, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function apiKeyMatches(key: string, storedHash: string | null | undefined): boolean {
  if (!key || !storedHash) return false;
  const a = Buffer.from(hashApiKey(key), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Brand slug embedded in an API key, or null. */
export function slugFromApiKey(key: string): string | null {
  const m = /^eb_([a-z0-9][a-z0-9-]{1,40})_[A-Za-z0-9_-]{20,}$/.exec(key);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// admin session cookie:  <expiresEpochSec>.<hmac>
// ---------------------------------------------------------------------------
export const ADMIN_COOKIE = "eb_admin";

export function signAdminSession(password: string, ttlSeconds = 60 * 60 * 12, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  return `${exp}.${mac(password, `admin-session.${exp}`)}`;
}

export function verifyAdminSession(value: string | undefined, password: string | undefined, now = Date.now()): boolean {
  if (!value || !password) return false;
  const [expStr, sig] = value.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < now || !sig) return false;
  const a = Buffer.from(sig, "base64url");
  const b = Buffer.from(mac(password, `admin-session.${exp}`), "base64url");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function passwordMatches(given: string, expected: string | undefined): boolean {
  if (!expected || expected.length < 12) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
