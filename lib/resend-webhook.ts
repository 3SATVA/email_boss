import crypto from "node:crypto";
import type { SesEvent } from "./engine/ses-events";

/**
 * Resend webhooks are signed with Svix: headers svix-id, svix-timestamp, svix-signature
 * ("v1,<base64> v1,<base64>"), secret "whsec_<base64>", HMAC-SHA256 over "<id>.<timestamp>.<body>".
 */
export function verifySvix(
  secret: string | undefined,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  now = new Date(),
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > 5 * 60) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = crypto.createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${body}`).digest();
  for (const part of headers.signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export function signSvixForTest(secret: string, id: string, timestamp: string, body: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  return "v1," + crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

interface ResendPayload {
  type: string;
  created_at?: string;
  data: {
    email_id: string;
    to?: string[];
    bounce?: { type?: string; subType?: string; message?: string };
    click?: { link?: string };
  };
}

/** Translate a Resend webhook into the SES event shape so both share one handler. Null = ignore. */
export function resendToSesEvent(p: ResendPayload): SesEvent | null {
  const mail = { messageId: p.data?.email_id, destination: p.data?.to ?? [] };
  if (!mail.messageId) return null;
  const recipients = (p.data.to ?? []).map((emailAddress) => ({ emailAddress }));
  switch (p.type) {
    case "email.bounced": {
      const t = (p.data.bounce?.type ?? "Permanent").toLowerCase();
      return {
        eventType: "Bounce",
        mail,
        bounce: {
          bounceType: t.startsWith("perm") || t === "hard" ? "Permanent" : "Transient",
          bounceSubType: p.data.bounce?.subType,
          bouncedRecipients: recipients.map((r) => ({ ...r, diagnosticCode: p.data.bounce?.message })),
        },
      };
    }
    case "email.complained":
      return { eventType: "Complaint", mail, complaint: { complainedRecipients: recipients } };
    case "email.delivered":
      return { eventType: "Delivery", mail, delivery: {} };
    case "email.opened":
      return { eventType: "Open", mail, open: {} };
    case "email.clicked":
      return { eventType: "Click", mail, click: { link: p.data.click?.link } };
    case "email.delivery_delayed":
      return { eventType: "DeliveryDelay", mail, deliveryDelay: {} };
    default:
      return null;
  }
}
