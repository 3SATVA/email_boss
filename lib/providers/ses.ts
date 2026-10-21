import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { PermanentSendError, sanitizeTagValue, type EmailProvider, type OutgoingEmail } from "./types";

/**
 * Amazon SES (API v2). Credentials come from the standard AWS env vars
 * (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, region from SES_REGION or AWS_REGION).
 * Use an IAM user that can only call ses:SendEmail (see README).
 */
export function buildSesCommandInput(msg: OutgoingEmail) {
  return {
    FromEmailAddress: msg.from,
    Destination: { ToAddresses: [msg.to] },
    ReplyToAddresses: msg.replyTo ? [msg.replyTo] : undefined,
    ConfigurationSetName: msg.configurationSet,
    EmailTags: Object.entries(msg.tags).map(([Name, Value]) => ({ Name: sanitizeTagValue(Name), Value: sanitizeTagValue(Value) })),
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: msg.html, Charset: "UTF-8" },
          Text: { Data: msg.text, Charset: "UTF-8" },
        },
        Headers: Object.entries(msg.headers).map(([Name, Value]) => ({ Name, Value })),
      },
    },
  };
}

export class SesProvider implements EmailProvider {
  readonly name = "ses" as const;
  private client: SESv2Client;

  constructor(region = process.env.SES_REGION || process.env.AWS_REGION || "us-west-2", client?: SESv2Client) {
    this.client = client ?? new SESv2Client({ region });
  }

  async send(msg: OutgoingEmail) {
    try {
      const out = await this.client.send(new SendEmailCommand(buildSesCommandInput(msg)));
      if (!out.MessageId) throw new Error("SES returned no MessageId");
      return { provider: "ses", messageId: out.MessageId };
    } catch (e) {
      const name = (e as { name?: string }).name ?? "";
      // MessageRejected / MailFromDomainNotVerified / AccountSuspended etc. won't fix themselves on retry.
      if (["MessageRejected", "MailFromDomainNotVerifiedException", "BadRequestException", "NotFoundException"].includes(name)) {
        throw new PermanentSendError(`${name}: ${(e as Error).message}`);
      }
      throw e;
    }
  }
}
