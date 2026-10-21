/**
 * Send (or just render) one real template to an allowlisted test address.
 *
 *   TEST_RECIPIENTS=you@example.com npm run test-send -- --brand yonisync --template quiz-01-lets-understand-your-fertility-type --to you@example.com
 *   ... [--first-name Maya] [--custom fertility_type="Kidney Yin"] [--provider ses|resend]
 *
 * Default provider is "log": nothing is emailed, the rendered HTML is written to .test-sends/.
 * A real provider additionally needs SEND_ENABLED=true and AWS/Resend credentials.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBrandDir } from "../lib/brands/load";
import { testSend } from "../lib/engine/test-send";
import { defaultProviderResolver, type ProviderName } from "../lib/providers";
import { parseArgs } from "./_args";

const args = parseArgs();
const slug = args.get("brand");
const templateId = args.get("template");
const to = args.get("to");
if (!slug || !templateId || !to) {
  console.error("usage: npm run test-send -- --brand <slug> --template <id> --to <allowlisted email> [--provider ses|resend] [--first-name X] [--custom k=v]");
  process.exit(1);
}
const custom: Record<string, string> = {};
for (const kv of args.all("custom")) {
  const [k, ...v] = kv.split("=");
  custom[k] = v.join("=");
}
try {
  const bundle = loadBrandDir(path.resolve(process.env.BRANDS_DIR || "brands", slug));
  const r = await testSend({
    bundle, templateId, to, custom, firstName: args.get("first-name"),
    provider: args.get("provider") as ProviderName | undefined,
    resolve: defaultProviderResolver,
  });
  if (r.provider === "log") {
    fs.mkdirSync(".test-sends", { recursive: true });
    const file = path.join(".test-sends", `${slug}-${templateId}-${Date.now()}.html`);
    fs.writeFileSync(file, r.html);
    console.log(`rendered (not sent): ${r.subject}\nopen ${file}`);
  } else {
    console.log(`sent via ${r.provider}: ${r.subject} (message id ${r.messageId})`);
  }
  if (r.placeholderAddress) console.log("WARNING: physical_address is still REPLACE_ME; real sends are blocked by the runner until it's set");
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
