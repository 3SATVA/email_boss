import fs from "node:fs";
import path from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { Db } from "@/lib/db";
import { loadBrandsRoot } from "@/lib/brands/load";
import type { BrandBundle, Manifest } from "@/lib/brands/schema";
import { syncManifestToDb } from "@/lib/engine/sync";

type Q = PGlite | Transaction;

function wrap(q: Q, root: PGlite): Db {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const res = await q.query<T>(text, params.map((p) => (p instanceof Date ? p.toISOString() : p ?? null)));
      return res.rows;
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if (q !== root) return fn(wrap(q, root)); // nested: run inline (PGlite has no savepoint helper)
      return root.transaction((tx) => fn(wrap(tx, root)));
    },
  };
}

/** Fresh in-memory Postgres with Supabase-like roles and all migrations applied. */
export async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  await pg.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;`);
  const dir = path.resolve("supabase/migrations");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  return { db: wrap(pg, pg), pg };
}

/** Two test brands (alpha + beta) built from the real brand-folder format. */
export function testManifest(): Manifest {
  return loadBrandsRoot(path.resolve("tests/fixtures/brands"));
}

export async function seed(db: Db, manifest = testManifest()) {
  await syncManifestToDb(db, manifest);
  const rows = await db.query<{ id: string; slug: string }>(`select id, slug from email_boss.brands order by slug`);
  const ids = Object.fromEntries(rows.map((r) => [r.slug, r.id])) as Record<string, string>;
  // activate both brands, start warm-up long ago, lift caps for most tests
  await db.query(`update email_boss.brands set status = 'active', warmup_started_on = '2026-01-01', daily_cap_override = 1000`);
  return { manifest, ids };
}

export const TEST_ENV = {
  UNSUBSCRIBE_SECRET: "test-secret-0123456789abcdef",
  PUBLIC_BASE_URL: "https://mail.example.test",
} as unknown as NodeJS.ProcessEnv;

export function bundleOf(m: Manifest, slug: string): BrandBundle {
  return m.brands[slug];
}
