/**
 * Create a one-off broadcast (newsletter) for ONE brand.
 *
 *   npm run broadcast:create -- --brand yonisync --template newsletter-2026-11 --audience "*"
 *   npm run broadcast:create -- --brand starseed --template launch --audience "starseed-type:pleiadian,starseed-type:lyran" \
 *        --exclude "customer" --subject "Optional subject override" --schedule 2026-11-03T09:00:00-08:00 --commit
 *
 * --audience  "*" = everyone subscribed · "a,b" = any of these tags · "all:a,b" = all of these tags
 * --exclude   tags to leave out
 * --schedule  ISO time, or "now". Without it the broadcast is saved as a draft (nothing sends).
 * Without --commit this is a dry run: it validates the template, renders the subject and prints
 * audience counts. The cron tick sends scheduled broadcasts, within the brand's warm-up cap.
 */
import path from "node:path";
import { getDb, isDbConfigured } from "../lib/db";
import { loadBrandDir } from "../lib/brands/load";
import { audienceCounts, createBroadcast, describeSegment, parseAudience } from "../lib/engine/broadcasts";
import { remainingToday } from "../lib/engine/runner";
import type { BrandRow } from "../lib/engine/types";
import { sendingEnabled } from "../lib/providers";
import { mergeTags } from "../lib/templates";
import { parseArgs } from "./_args";

const args = parseArgs();
const slug = args.get("brand");
const templateId = args.get("template");
const audience = args.get("audience");
if (!slug || !templateId || !audience) {
  console.error('usage: npm run broadcast:create -- --brand <slug> --template <id> --audience "<tag filter>" [--exclude tags] [--subject s] [--name n] [--schedule ISO|now] [--commit]');
  process.exit(1);
}

const bundle = loadBrandDir(path.resolve(process.env.BRANDS_DIR || "brands", slug));
const tpl = bundle.templates[templateId];
if (!tpl) {
  console.error(`template "${templateId}" not found in brands/${slug}/templates (have: ${Object.keys(bundle.templates).join(", ")})`);
  process.exit(1);
}
const segment = parseAudience(audience, args.get("exclude") ?? "");
const schedule = args.get("schedule");
const scheduledAt = !schedule ? null : schedule === "now" ? new Date() : new Date(schedule);
if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
  console.error(`--schedule "${schedule}" is not a valid ISO date/time`);
  process.exit(1);
}
const subject = args.get("subject") ?? null;
const name = args.get("name") ?? `${templateId} (${new Date().toISOString().slice(0, 10)})`;
const sampleSubject = mergeTags(subject || tpl.subject, {
  first_name: "Maya", email: "maya@example.com", custom: {}, brand: { name: bundle.config.name, from_name: bundle.config.from_name },
  unsubscribe_url: "", physical_address: bundle.config.physical_address,
}, false);

console.log(`brand:     ${bundle.config.name} <${bundle.config.from_email}>`);
console.log(`template:  ${templateId}`);
console.log(`subject:   ${sampleSubject}`);
console.log(`audience:  ${describeSegment(segment)}`);
console.log(`schedule:  ${scheduledAt ? scheduledAt.toISOString() : "draft (no --schedule)"}`);
if (/REPLACE_ME/.test(bundle.config.physical_address)) console.log("WARNING:   brand physical_address is a placeholder; sending is blocked until it's set");
if (!sendingEnabled()) console.log("NOTE:      SEND_ENABLED is not true -> the tick would only dry-run (log provider)");

if (!isDbConfigured()) {
  console.log("\nSUPABASE_DB_URL not set: audience counts unavailable. Nothing was saved.");
  process.exit(0);
}
const db = getDb();
const [brand] = await db.query<BrandRow>(`select * from email_boss.brands where slug = $1`, [slug]);
if (!brand) {
  console.error(`brand ${slug} not in the database; run npm run brands:sync-db`);
  process.exit(1);
}
const counts = await audienceCounts(db, brand.id, segment);
const cap = await remainingToday(db, brand, new Date());
console.log(`\nrecipients: ${counts.recipients} subscribed (of ${counts.subscribedTotal}); ${counts.suppressed} matching contacts are suppressed and won't be emailed`);
if (counts.unknownTags.length) console.log(`WARNING:   these tags don't exist in ${slug}: ${counts.unknownTags.join(", ")}`);
console.log(`today:      cap ${cap.cap}, already sent ${cap.sentToday}${brand.status !== "active" ? ` · brand is ${brand.status} (nothing sends until active)` : ""}`);
if (counts.recipients > cap.remaining) console.log("            the broadcast will continue over the following days within the warm-up cap");

if (!args.has("commit")) {
  console.log("\nDry run. Re-run with --commit to save it.");
  process.exit(0);
}
const id = await createBroadcast(db, { brandId: brand.id, name, templateId, subject, segment, scheduledAt });
console.log(`\nsaved broadcast ${id} (${scheduledAt ? "scheduled" : "draft"})`);
console.log(scheduledAt ? "Cancel before it sends: update email_boss.broadcasts set status = 'canceled' where id = '" + id + "';" : "Schedule it later: update email_boss.broadcasts set status = 'scheduled', scheduled_at = now() where id = '" + id + "';");
process.exit(0);
