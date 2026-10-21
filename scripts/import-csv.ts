/**
 * Import a CSV export (Constant Contact, systeme.io, ...) into ONE brand.
 *
 *   npm run import:csv -- --brand starseed --file ~/starseed.csv --source constant_contact \
 *        [--format auto|systeme|constant_contact] [--tag imported:cc-2026-10] [--suppress-tag unsubscribed]
 *        [--map email="Email address"] [--no-custom] [--commit]
 *
 * Output is aggregate counts only (never contact data). --show-invalid prints up to 20 invalid values.
 *
 * Without --commit it's a dry run that only prints what would happen.
 * Imports never trigger sequences. Unsubscribed/bounced/complained rows stay suppressed.
 */
import fs from "node:fs";
import { getDb } from "../lib/db";
import { importContacts, parseContactsCsv, type ImportFormat } from "../lib/import/csv";
import { parseArgs } from "./_args";

const args = parseArgs();
const brand = args.get("brand");
const file = args.get("file");
const source = args.get("source") ?? "csv_import";
if (!brand || !file) {
  console.error("usage: npm run import:csv -- --brand <slug> --file <path.csv> [--source name] [--tag t] [--map field=Column] [--commit]");
  process.exit(1);
}
const columns: Record<string, string> = {};
for (const m of args.all("map")) {
  const [k, ...rest] = m.split("=");
  columns[k] = rest.join("=");
}

const format = (args.get("format") ?? "auto") as ImportFormat;
if (!["auto", "systeme", "constant_contact"].includes(format)) {
  console.error("--format must be auto, systeme or constant_contact");
  process.exit(1);
}
const { contacts, stats } = parseContactsCsv(fs.readFileSync(file, "utf8"), {
  columns,
  format,
  extraTags: args.all("tag"),
  suppressTags: args.all("suppress-tag"),
  keepCustom: !args.has("no-custom"),
});
// Aggregate output only: contact data is PII and must not end up in logs.
console.log(`format: ${stats.format}`);
console.log("columns detected:", stats.columns);
console.log(`rows ${stats.rows} · unique valid ${stats.valid} · invalid ${stats.invalid.length} · duplicates merged ${stats.duplicatesMerged} · pending skipped ${stats.skippedPending} · no permission (imported as unsubscribed) ${stats.noPermission}`);
console.log("by status:", stats.byStatus);
console.log(`with consent/registration date: ${stats.withConsentDate}`);
if (Object.keys(stats.unknownStatuses).length) console.log("unknown status values (imported as unsubscribed):", stats.unknownStatuses);
const tagList = Object.entries(stats.tagCounts).sort((x, y) => y[1] - x[1]);
console.log(`tags (${tagList.length}):`);
for (const [t, n] of tagList.slice(0, Number(args.get("top-tags") ?? 60))) console.log(`  ${String(n).padStart(6)}  ${t}`);
if (stats.invalid.length) {
  console.log(`invalid email rows: ${stats.invalid.length} (row numbers: ${stats.invalid.slice(0, 20).map((x) => x.row).join(", ")})`);
  if (args.has("show-invalid")) console.log(stats.invalid.slice(0, 20));
}
if (stats.format === "systeme" && !stats.columns.status.length) {
  console.log("NOTE: systeme.io exports have no unsubscribe/bounce column. Confirm unsubscribed contacts are excluded from the export,\n      or pass --suppress-tag <tag> for any tag that marks them.");
}

if (!args.has("commit")) {
  console.log("\nDry run. Re-run with --commit to write to the database.");
  process.exit(0);
}
const db = getDb();
const [row] = await db.query<{ id: string }>(`select id from email_boss.brands where slug = $1`, [brand]);
if (!row) {
  console.error(`brand ${brand} not found; run npm run brands:sync-db first`);
  process.exit(1);
}
const r = await importContacts(db, row.id, contacts, { source });
console.log(`done: inserted ${r.inserted}, updated ${r.updated}`);
process.exit(0);
