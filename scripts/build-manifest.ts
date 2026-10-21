/**
 * Compile every brand folder into lib/generated/manifest.json (bundled into the app).
 *
 *   BRANDS_DIRS=brands:../susana/email   npm run manifest
 *
 * BRANDS_DIRS is a ":"-separated list of roots; each root holds one folder per brand slug.
 * Defaults to ./brands. With --check it only validates.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBrandsRoot } from "../lib/brands/load";
import type { Manifest } from "../lib/brands/schema";

const roots = (process.env.BRANDS_DIRS || "brands").split(":").filter(Boolean);
const merged: Manifest = { generated_at: new Date().toISOString(), brands: {} };
try {
  for (const root of roots) {
    const m = loadBrandsRoot(path.resolve(root));
    for (const [slug, b] of Object.entries(m.brands)) {
      if (merged.brands[slug]) throw new Error(`brand "${slug}" is defined in more than one BRANDS_DIRS root`);
      merged.brands[slug] = b;
    }
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const summary = Object.values(merged.brands)
  .map((b) => `${b.config.slug} (${Object.keys(b.templates).length} templates, ${b.sequences.length} sequences)`)
  .join(", ");
if (process.argv.includes("--check")) {
  console.log(`brands ok: ${summary || "none"}`);
} else {
  const out = path.resolve("lib/generated/manifest.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(merged, null, 2) + "\n");
  console.log(`manifest written: ${summary || "no brands"}`);
}
