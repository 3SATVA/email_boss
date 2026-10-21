/**
 * Create (or rotate) a brand's API key for POST /api/subscribe.
 *   npm run brand:key -- yonisync
 * Prints the key ONCE; only its sha256 hash is stored. Put the key in the brand site's env
 * (e.g. EMAIL_BOSS_API_KEY on the yonisync-quiz Vercel project). Never commit it.
 */
import { getDb } from "../lib/db";
import { generateBrandApiKey } from "../lib/tokens";
import { parseArgs } from "./_args";

const slug = parseArgs().positional[0];
if (!slug) {
  console.error("usage: npm run brand:key -- <brand-slug>");
  process.exit(1);
}
const { key, hash } = generateBrandApiKey(slug);
const rows = await getDb().query(`update email_boss.brands set api_key_hash = $2 where slug = $1 returning id`, [slug, hash]);
if (!rows.length) {
  console.error(`brand ${slug} not found; run npm run brands:sync-db first`);
  process.exit(1);
}
console.log(`New API key for ${slug} (previous key no longer works):\n\n${key}\n`);
process.exit(0);
