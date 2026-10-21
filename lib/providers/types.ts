export interface OutgoingEmail {
  /** "Name <addr@domain>" */
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** extra MIME headers (List-Unsubscribe etc.) */
  headers: Record<string, string>;
  /** provider tags for analytics/webhooks. keys/values: [A-Za-z0-9_-] */
  tags: Record<string, string>;
  /** SES configuration set (per brand) */
  configurationSet?: string;
}

export interface SendResult {
  provider: string;
  messageId: string;
}

export interface EmailProvider {
  readonly name: "ses" | "resend" | "log";
  send(msg: OutgoingEmail): Promise<SendResult>;
}

/** Errors that should not be retried (bad address, rejected content, ...). */
export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSendError";
  }
}

export function formatFrom(name: string, email: string): string {
  const safe = name.replace(/["\\\r\n]/g, "").trim();
  return safe ? `"${safe}" <${email}>` : email;
}

export function sanitizeTagValue(v: string): string {
  return v.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "_";
}
