import { describe, expect, it } from "vitest";
import {
  apiKeyMatches, generateBrandApiKey, signAdminSession, signUnsubscribeToken, slugFromApiKey,
  verifyAdminSession, verifyUnsubscribeToken, passwordMatches,
} from "@/lib/tokens";

const C = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const B2 = "33333333-3333-4333-8333-333333333333";
const SECRET = "s3cret-s3cret-s3cret";

describe("unsubscribe tokens", () => {
  it("round-trips contact + brand", () => {
    const t = signUnsubscribeToken(C, B, SECRET);
    expect(verifyUnsubscribeToken(t, [SECRET])).toEqual({ contactId: C, brandId: B });
  });

  it("rejects a wrong secret", () => {
    const t = signUnsubscribeToken(C, B, SECRET);
    expect(verifyUnsubscribeToken(t, ["another-secret-value"])).toBeNull();
  });

  it("rejects tampering with the brand or contact id", () => {
    const t = signUnsubscribeToken(C, B, SECRET);
    expect(verifyUnsubscribeToken(t.replace(B, B2), [SECRET])).toBeNull();
    expect(verifyUnsubscribeToken(t.replace(C, B2), [SECRET])).toBeNull();
    const sig = t.split(".")[3];
    expect(verifyUnsubscribeToken(t.slice(0, -sig.length) + "A".repeat(sig.length), [SECRET])).toBeNull();
  });

  it("rejects malformed input", () => {
    for (const bad of [null, undefined, "", "v1", "v2.a.b.c", `v1.${C}.${B}`, `v1.not-a-uuid.${B}.x`, "x".repeat(500)]) {
      expect(verifyUnsubscribeToken(bad as string, [SECRET])).toBeNull();
    }
  });

  it("supports secret rotation via the previous secret", () => {
    const old = signUnsubscribeToken(C, B, "old-secret-old-secret");
    expect(verifyUnsubscribeToken(old, [SECRET, "old-secret-old-secret"])).toEqual({ contactId: C, brandId: B });
    expect(verifyUnsubscribeToken(old, [SECRET])).toBeNull();
  });

  it("refuses to sign with a weak secret", () => {
    expect(() => signUnsubscribeToken(C, B, "short")).toThrow();
  });

  it("is url-safe", () => {
    expect(signUnsubscribeToken(C, B, SECRET)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("brand api keys", () => {
  it("embeds the slug and only matches its own hash", () => {
    const a = generateBrandApiKey("alpha");
    const b = generateBrandApiKey("beta");
    expect(slugFromApiKey(a.key)).toBe("alpha");
    expect(apiKeyMatches(a.key, a.hash)).toBe(true);
    expect(apiKeyMatches(a.key, b.hash)).toBe(false);
    expect(apiKeyMatches(a.key, null)).toBe(false);
    expect(slugFromApiKey("eb_alpha_short")).toBeNull();
  });
});

describe("admin session", () => {
  it("verifies and expires", () => {
    const pw = "correct horse battery";
    const now = Date.UTC(2026, 9, 21);
    const s = signAdminSession(pw, 60, now);
    expect(verifyAdminSession(s, pw, now)).toBe(true);
    expect(verifyAdminSession(s, "other password!!", now)).toBe(false);
    expect(verifyAdminSession(s, pw, now + 61_000)).toBe(false);
    expect(passwordMatches(pw, pw)).toBe(true);
    expect(passwordMatches(pw, "short")).toBe(false);
  });
});
