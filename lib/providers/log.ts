import crypto from "node:crypto";
import type { EmailProvider, OutgoingEmail } from "./types";

/**
 * Dry-run provider: sends nothing, records messages in memory and logs one line.
 * This is the default whenever SEND_ENABLED !== "true".
 */
export class LogProvider implements EmailProvider {
  readonly name = "log" as const;
  readonly outbox: OutgoingEmail[] = [];
  constructor(private quiet = false) {}

  async send(msg: OutgoingEmail) {
    this.outbox.push(msg);
    if (!this.quiet) console.log(`[dry-run] would send "${msg.subject}" to ${msg.to} from ${msg.from}`);
    return { provider: "log", messageId: `dryrun-${crypto.randomUUID()}` };
  }
}
