/**
 * Import a CSV export (Constant Contact, systeme.io, ...) into ONE brand.
 *
 *   npm run import:csv -- --brand starseed --file ~/starseed.csv --source constant_contact \
 *        [--tag imported:cc-2026-10] [--map email="Email address"] [--commit]
 *
 * Without --commit it's a dry run that only prints what would happen.
 * Imports never trigger sequences. Unsubscribed/bounced/complained rows stay suppressed.
 */
import fs from "node:fs";
import { getDb } from "../lib/db";
import { importContacts, parseContactsCsv } from "../lib/import/csv";
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

const { contacts, stats } = parseContactsCsv(fs.readFileSync(file, "utf8"), {
  columns,
  extraTags: args.all("tag"),
  keepCustom: !args.has("no-custom"),
});
console.log("columns detected:", stats.columns);
console.log(`rows ${stats.rows} · unique valid ${stats.valid} · invalid ${stats.invalid.length} · duplicates merged ${stats.duplicatesMerged} · pending skipped ${stats.skippedPending}`);
console.log("by status:", stats.byStatus);
if (Object.keys(stats.unknownStatuses).length) console.log("unknown status values (imported as unsubscribed):", stats.unknownStatuses);
if (stats.invalid.length) console.log("first invalid rows:", stats.invalid.slice(0, 10));

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
