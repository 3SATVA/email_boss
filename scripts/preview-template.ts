/**
 * Render a template to an HTML file with sample data (for test sends / review).
 *   npm run preview -- yonisync quiz-welcome [out.html]
 */
import fs from "node:fs";
import path from "node:path";
import { loadBrandDir } from "../lib/brands/load";
import { renderEmail } from "../lib/templates";
import { parseArgs } from "./_args";

const [slug, id, out] = parseArgs().positional;
if (!slug || !id) {
  console.error("usage: npm run preview -- <brand> <template-id> [out.html]");
  process.exit(1);
}
const bundle = loadBrandDir(path.resolve(process.env.BRANDS_DIR || "brands", slug));
const tpl = bundle.templates[id];
if (!tpl) throw new Error(`no template ${id}`);
const r = renderEmail(tpl, bundle.partials, {
  first_name: "Maya",
  email: "maya@example.com",
  custom: { fertility_type: "Kidney Yin Deficiency" },
  brand: { name: bundle.config.name, from_name: bundle.config.from_name },
  unsubscribe_url: "https://example.com/unsubscribe?t=preview",
  physical_address: bundle.config.physical_address,
});
const file = out ?? `preview-${slug}-${id}.html`;
fs.writeFileSync(file, r.html);
console.log(`subject: ${r.subject}\nwrote ${file}`);
