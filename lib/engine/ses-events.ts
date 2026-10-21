import type { Db } from "../db";
import { suppressContact } from "./contacts";
import { normalizeEmail } from "./types";

/**
 * Handle one SES event notification (configuration-set event destination -> SNS -> webhook,
 * which uses `eventType`; or identity feedback notifications, which use `notificationType`).
 */
export interface SesEvent {
  eventType?: string;
  notificationType?: string;
  mail: { messageId: string; destination?: string[]; tags?: Record<string, string[]>; timestamp?: string };
  bounce?: { bounceType: string; bounceSubType?: string; bouncedRecipients: { emailAddress: string; diagnosticCode?: string }[]; timestamp?: string };
  complaint?: { complainedRecipients: { emailAddress: string }[]; complaintFeedbackType?: string; timestamp?: string };
  delivery?: { recipients?: string[]; timestamp?: string };
  open?: { timestamp?: string; userAgent?: string };
  click?: { timestamp?: string; link?: string };
  reject?: { reason?: string };
  deliveryDelay?: { delayType?: string };
}

export interface HandledEvent {
  type: string;
  matched: boolean;
  suppressed: number;
}

export async function handleSesEvent(db: Db, ev: SesEvent, eventId: string, now = new Date()): Promise<HandledEvent> {
  const kind = (ev.eventType ?? ev.notificationType ?? "").toLowerCase();
  const messageId = ev.mail?.messageId;
  const sends = messageId
    ? await db.query<{ id: string; brand_id: string; contact_id: string; email: string }>(
        `select s.id, s.brand_id, s.contact_id, c.email from email_boss.sends s
           join email_boss.contacts c on c.id = s.contact_id and c.brand_id = s.brand_id
          where s.provider_message_id = $1`,
        [messageId],
      )
    : [];
  const send = sends[0];
  // Without a matching send we cannot know the brand safely -> record nothing (no cross-brand guessing).
  if (!send) return { type: kind, matched: false, suppressed: 0 };

  const recipientMatches = (addr: string) => normalizeEmail(addr) === send.email;
  let suppressed = 0;
  const record = async (type: string, data: Record<string, unknown>, suffix = "") =>
    db.query(
      `insert into email_boss.events (brand_id, contact_id, send_id, type, occurred_at, data, provider_event_id)
       values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb, $7) on conflict (provider_event_id) do nothing`,
      [send.brand_id, send.contact_id, send.id, type, now.toISOString(), JSON.stringify(data), eventId + suffix],
    );

  switch (kind) {
    case "bounce": {
      const b = ev.bounce!;
      const hits = b.bouncedRecipients.filter((r) => recipientMatches(r.emailAddress));
      const data = { bounceType: b.bounceType, bounceSubType: b.bounceSubType, diagnostic: hits[0]?.diagnosticCode };
      if (b.bounceType === "Permanent" && hits.length) {
        const r = await suppressContact(db, { contactId: send.contact_id, brandId: send.brand_id, status: "bounced", now, data, sendId: send.id, providerEventId: eventId });
        if (r.changed) suppressed++;
      } else {
        await record("soft_bounce", data);
      }
      break;
    }
    case "complaint": {
      const c = ev.complaint!;
      if (c.complainedRecipients.some((r) => recipientMatches(r.emailAddress))) {
        const r = await suppressContact(db, {
          contactId: send.contact_id, brandId: send.brand_id, status: "complained", now,
          data: { feedbackType: c.complaintFeedbackType }, sendId: send.id, providerEventId: eventId,
        });
        if (r.changed) suppressed++;
      }
      break;
    }
    case "delivery":
      await record("delivered", {});
      break;
    case "open":
      await record("open", { userAgent: ev.open?.userAgent });
      break;
    case "click":
      await record("click", { link: ev.click?.link });
      break;
    case "reject":
      await record("reject", { reason: ev.reject?.reason });
      break;
    case "deliverydelay":
      await record("delivery_delay", { delayType: ev.deliveryDelay?.delayType });
      break;
    default:
      // "send", "rendering failure", "subscription" ... nothing to do
      break;
  }
  return { type: kind, matched: true, suppressed };
}
