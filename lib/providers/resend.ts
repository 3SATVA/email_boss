import { PermanentSendError, sanitizeTagValue, type EmailProvider, type OutgoingEmail } from "./types";

/** Resend (https://resend.com) — drop-in alternative; free tier 3,000 emails/mo. */
export class ResendProvider implements EmailProvider {
  readonly name = "resend" as const;
  constructor(
    private apiKey = process.env.RESEND_API_KEY,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: OutgoingEmail) {
    if (!this.apiKey) throw new PermanentSendError("RESEND_API_KEY is not set");
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: msg.from,
        to: [msg.to],
        reply_to: msg.replyTo,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        headers: msg.headers,
        tags: Object.entries(msg.tags).map(([name, value]) => ({ name: sanitizeTagValue(name), value: sanitizeTagValue(value) })),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !body.id) {
      const err = `Resend ${res.status}: ${body.message ?? "unknown error"}`;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new PermanentSendError(err);
      throw new Error(err);
    }
    return { provider: "resend", messageId: body.id };
  }
}
