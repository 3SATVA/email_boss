/**
 * Push brand settings + sequences from lib/generated/manifest.json into the database.
 *   npm run manifest && npm run brands:sync-db
 * Needs SUPABASE_DB_URL. Safe to re-run.
 */
import fs from "node:fs";
import { getDb } from "../lib/db";
import { syncManifestToDb } from "../lib/engine/sync";
import type { Manifest } from "../lib/brands/schema";

const manifest = JSON.parse(fs.readFileSync("lib/generated/manifest.json", "utf8")) as Manifest;
const r = await syncManifestToDb(getDb(), manifest);
console.log(`synced brands: ${r.brands.join(", ")} · ${r.sequences} sequences · ${r.steps} steps`);
process.exit(0);
