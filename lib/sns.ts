import crypto from "node:crypto";

/**
 * Amazon SNS HTTP(S) message signature verification
 * (https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).
 */
export interface SnsMessage {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: "1" | "2";
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  UnsubscribeURL?: string;
}

const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** https://sns.<region>.amazonaws.com/... (used for SubscribeURL) */
export function isSnsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && CERT_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

export function isTrustedCertUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && CERT_HOST.test(u.hostname) && u.pathname.endsWith(".pem");
  } catch {
    return false;
  }
}

export function stringToSign(m: SnsMessage): string {
  const keys =
    m.Type === "Notification"
      ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  let out = "";
  for (const k of keys) {
    const v = (m as unknown as Record<string, string | undefined>)[k];
    if (v === undefined) continue; // Subject is optional
    out += `${k}\n${v}\n`;
  }
  return out;
}

const certCache = new Map<string, string>();

export async function defaultCertFetcher(url: string): Promise<string> {
  const hit = certCache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cert fetch ${res.status}`);
  const pem = await res.text();
  certCache.set(url, pem);
  return pem;
}

export async function verifySnsMessage(
  m: SnsMessage,
  opts: { allowedTopicArns: string[]; fetchCert?: (url: string) => Promise<string>; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!m || typeof m !== "object" || !m.Type || !m.Signature) return { ok: false, reason: "not an SNS message" };
  if (!opts.allowedTopicArns.includes(m.TopicArn)) return { ok: false, reason: "topic not allowed" };
  if (!isTrustedCertUrl(m.SigningCertURL)) return { ok: false, reason: "untrusted cert url" };
  const ts = Date.parse(m.Timestamp);
  const now = (opts.now ?? new Date()).getTime();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 60 * 60 * 1000) return { ok: false, reason: "stale timestamp" };
  const alg = m.SignatureVersion === "2" ? "RSA-SHA256" : m.SignatureVersion === "1" ? "RSA-SHA1" : null;
  if (!alg) return { ok: false, reason: "unknown signature version" };
  const pem = await (opts.fetchCert ?? defaultCertFetcher)(m.SigningCertURL);
  const ok = crypto.createVerify(alg).update(stringToSign(m), "utf8").verify(pem, m.Signature, "base64");
  return ok ? { ok: true } : { ok: false, reason: "bad signature" };
}
