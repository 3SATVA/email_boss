import type { BrandBundle } from "../brands/schema";
import { formatFrom, sendingEnabled, type EmailProvider, type ProviderName } from "../providers";
import { renderEmail } from "../templates";
import { normalizeEmail } from "./types";

/** TEST_RECIPIENTS="michael@x.com, susana@y.com" -> set of normalized addresses. */
export function testRecipients(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.TEST_RECIPIENTS ?? "")
      .split(/[,\s]+/)
      .map((e) => normalizeEmail(e))
      .filter((e): e is string => Boolean(e)),
  );
}

export interface TestSendOptions {
  bundle: BrandBundle;
  templateId: string;
  to: string;
  provider?: ProviderName;
  firstName?: string;
  custom?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  resolve: (name: ProviderName) => EmailProvider;
}

/**
 * Render the real template (real partials, brand sender, footer) and send it to ONE
 * allowlisted address. The subject is prefixed with [TEST] and the unsubscribe link is inert.
 * Default provider: log (nothing leaves the machine). A real provider also needs SEND_ENABLED=true.
 */
export async function testSend(o: TestSendOptions) {
  const env = o.env ?? process.env;
  const allow = testRecipients(env);
  const to = normalizeEmail(o.to);
  if (!to) throw new Error(`invalid --to address`);
  if (!allow.size) throw new Error("TEST_RECIPIENTS is empty; set it to a comma-separated list of your own addresses");
  if (!allow.has(to)) throw new Error(`${to} is not in TEST_RECIPIENTS`);
  const tpl = o.bundle.templates[o.templateId];
  if (!tpl) throw new Error(`template "${o.templateId}" not found (have: ${Object.keys(o.bundle.templates).join(", ")})`);
  const providerName = o.provider ?? "log";
  if (providerName !== "log" && !sendingEnabled(env)) {
    throw new Error(`--provider ${providerName} needs SEND_ENABLED=true; omit --provider to render with the log provider`);
  }
  const base = (env.PUBLIC_BASE_URL || "https://email-boss.invalid").replace(/\/$/, "");
  const unsub = `${base}/unsubscribe?t=test-send`;
  const r = renderEmail(tpl, o.bundle.partials, {
    first_name: o.firstName ?? "Michael",
    email: to,
    custom: o.custom ?? {},
    brand: { name: o.bundle.config.name, from_name: o.bundle.config.from_name },
    unsubscribe_url: unsub,
    physical_address: o.bundle.config.physical_address,
  });
  const subject = `[TEST] ${r.subject}`;
  const result = await o.resolve(providerName).send({
    from: formatFrom(o.bundle.config.from_name, o.bundle.config.from_email),
    to,
    replyTo: o.bundle.config.reply_to,
    subject,
    html: r.html,
    text: r.text,
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-Email-Boss-Test": "1" },
    tags: { brand: o.bundle.config.slug, kind: "test" },
    configurationSet: o.bundle.config.ses_configuration_set,
  });
  return {
    ...result,
    subject,
    html: r.html,
    text: r.text,
    placeholderAddress: /REPLACE_ME/.test(o.bundle.config.physical_address),
  };
}
