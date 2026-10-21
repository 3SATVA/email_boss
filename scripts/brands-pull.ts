/**
 * Vendor brand folders from their brand repos (brands.sources.json) into brands/<slug>/.
 *
 *   npm run brands:pull                 # all brands
 *   npm run brands:pull -- yonisync     # one brand
 *   npm run brands:pull -- --check      # only report which vendored copies are behind their ref
 *
 * Auth: GH_TOKEN / GITHUB_TOKEN, else `gh auth token`. Commit the result; the Vercel build
 * then uses the vendored copy and needs no access to the brand repos.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pullBrand, readSourceRecord, readSources, resolveCommit } from "../lib/brands/pull";
import { parseArgs } from "./_args";

function token(): string | undefined {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const args = parseArgs();
const sources = readSources();
const wanted = args.positional.length ? args.positional : Object.keys(sources.brands);
const root = path.resolve("brands");
const tok = token();
let failed = false;

for (const slug of wanted) {
  const src = sources.brands[slug];
  if (!src) {
    console.error(`${slug}: not in brands.sources.json`);
    failed = true;
    continue;
  }
  try {
    if (args.has("check")) {
      const head = await resolveCommit(src, tok);
      const have = readSourceRecord(path.join(root, slug))?.commit;
      console.log(`${slug}: ${src.repo}/${src.path}@${src.ref} -> ${head.slice(0, 7)}; vendored ${have?.slice(0, 7) ?? "none"}${have === head ? " (up to date)" : " (BEHIND)"}`);
      if (have !== head) failed = true;
    } else {
      const r = await pullBrand(slug, src, { destRoot: root, token: tok });
      console.log(`${slug}: pulled ${r.files} files from ${r.repo}/${r.path}@${r.commit.slice(0, 7)}`);
    }
  } catch (e) {
    console.error(`${slug}: ${(e as Error).message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
