import postgres from "postgres";

/**
 * Minimal database interface so the engine runs against real Postgres (postgres.js, in
 * production) and an in-memory Postgres (PGlite, in tests) with the same SQL.
 *
 * Conventions for SQL in this codebase:
 *  - always pass values as $1..$n parameters (never string-concatenate user input)
 *  - arrays: pass pgArray([...]) and cast `$n::text[]`
 *  - json:   pass JSON.stringify(x) and cast `$n::jsonb`
 *  - times:  pass ISO strings and cast `$n::timestamptz`
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Encode a JS string array as a Postgres array literal, for `$n::text[]` params. */
export function pgArray(values: readonly string[]): string {
  return "{" + values.map((v) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(",") + "}";
}

function normalizeParams(params: unknown[] = []): unknown[] {
  return params.map((p) => (p instanceof Date ? p.toISOString() : p === undefined ? null : p));
}

type PgSql = postgres.Sql | postgres.TransactionSql;

function wrapPostgres(sql: PgSql): Db {
  return {
    async query<T>(text: string, params?: unknown[]) {
      const rows = await sql.unsafe(text, normalizeParams(params) as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      if ("savepoint" in sql && typeof (sql as postgres.TransactionSql).savepoint === "function") {
        return (await (sql as postgres.TransactionSql).savepoint((s) => fn(wrapPostgres(s)))) as T;
      }
      return (await (sql as postgres.Sql).begin((s) => fn(wrapPostgres(s)))) as T;
    },
  };
}

let shared: Db | null = null;

/** Database from SUPABASE_DB_URL (use the Supabase pooler URL on Vercel). */
export function getDb(env: NodeJS.ProcessEnv = process.env): Db {
  if (shared) return shared;
  const url = env.SUPABASE_DB_URL;
  if (!url) throw new DbNotConfiguredError();
  const sql = postgres(url, {
    prepare: false, // required for the Supabase transaction pooler
    max: Number(env.DB_POOL_MAX ?? 3),
    idle_timeout: 20,
    connect_timeout: 10,
  });
  shared = wrapPostgres(sql);
  return shared;
}

export function isDbConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SUPABASE_DB_URL);
}

export class DbNotConfiguredError extends Error {
  constructor() {
    super("SUPABASE_DB_URL is not set");
    this.name = "DbNotConfiguredError";
  }
}
