/**
 * Contact-cleanup report: subscribed contacts with no open/click in N days (aggregate counts only).
 *
 *   npm run report:inactive -- --brand expo --days 365
 *   npm run report:inactive -- --brand expo --days 365 --tag inactive:365d --commit   # tag them
 *
 * Then exclude them from broadcasts: --exclude inactive:365d
 */
import { getDb } from "../lib/db";
import { normalizeTag } from "../lib/engine/types";
import { inactiveReport, tagInactive } from "../lib/engine/reports";
import { parseArgs } from "./_args";

const args = parseArgs();
const slug = args.get("brand");
const days = Number(args.get("days") ?? 365);
if (!slug || !Number.isInteger(days) || days < 1) {
  console.error("usage: npm run report:inactive -- --brand <slug> [--days 365] [--tag inactive:365d --commit]");
  process.exit(1);
}
const db = getDb();
const [brand] = await db.query<{ id: string }>(`select id from email_boss.brands where slug = $1`, [slug]);
if (!brand) {
  console.error(`brand ${slug} not found`);
  process.exit(1);
}
const r = await inactiveReport(db, brand.id, days);
console.log(`${slug}: ${r.subscribed} subscribed · engaged in last ${days}d: ${r.engaged} · inactive: ${r.inactive} · too early to judge: ${r.tooEarly} · never emailed by email_boss: ${r.noData}`);
const tag = args.get("tag");
if (tag) {
  const t = normalizeTag(tag);
  if (!t) throw new Error(`invalid tag ${tag}`);
  if (!args.has("commit")) console.log(`dry run: would tag ${r.inactive} contacts with "${t}" (add --commit)`);
  else console.log(`tagged ${await tagInactive(db, brand.id, days, t)} contacts with "${t}"`);
}
process.exit(0);
