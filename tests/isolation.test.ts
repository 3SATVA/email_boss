import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seed, TEST_ENV } from "./helpers/db";
import type { Db } from "@/lib/db";
import { subscribeContact, suppressContact } from "@/lib/engine/contacts";
import { runTick } from "@/lib/engine/runner";
import { LogProvider } from "@/lib/providers/log";
import { authenticateBrand } from "@/lib/server/brand-auth";
import { generateBrandApiKey, signUnsubscribeToken, unsubscribeSecrets, verifyUnsubscribeToken } from "@/lib/tokens";
import type { Manifest } from "@/lib/brands/schema";

let db: Db;
let ids: Record<string, string>;
let manifest: Manifest;
const now = new Date("2026-10-21T17:00:00Z");

beforeAll(async () => {
  ({ db } = await createTestDb());
  ({ ids, manifest } = await seed(db));
});

describe("brand isolation", () => {
  it("same email in two brands = two independent contacts", async () => {
    const a = await subscribeContact(db, ids.alpha, { email: "Same@Example.com", first_name: "A", tags: ["lead"] }, now);
    const b = await subscribeContact(db, ids.beta, { email: "same@example.com", first_name: "B" }, now);
    expect(a.contactId).not.toBe(b.contactId);
    expect(a.created && b.created).toBe(true);
    // the tag + enrollment happened only in alpha
    expect(a.enrolled).toEqual(["welcome"]);
    expect(b.enrolled).toEqual([]);
    const rows = await db.query<{ slug: string; first_name: string }>(
      `select b.slug, c.first_name from email_boss.contacts c join email_boss.brands b on b.id = c.brand_id where c.email = 'same@example.com' order by b.slug`,
    );
    expect(rows).toEqual([{ slug: "alpha", first_name: "A" }, { slug: "beta", first_name: "B" }]);
  });

  it("unsubscribing in one brand leaves the other brand subscribed", async () => {
    const [a] = await db.query<{ id: string }>(`select id from email_boss.contacts where brand_id = $1 and email = 'same@example.com'`, [ids.alpha]);
    const token = signUnsubscribeToken(a.id, ids.alpha, TEST_ENV.UNSUBSCRIBE_SECRET!);
    const claims = verifyUnsubscribeToken(token, unsubscribeSecrets(TEST_ENV))!;
    await suppressContact(db, { ...claims, status: "unsubscribed" });
    const rows = await db.query<{ slug: string; status: string }>(
      `select b.slug, c.status from email_boss.contacts c join email_boss.brands b on b.id = c.brand_id where c.email = 'same@example.com' order by b.slug`,
    );
    expect(rows).toEqual([{ slug: "alpha", status: "unsubscribed" }, { slug: "beta", status: "subscribed" }]);
  });

  it("a token for brand A cannot touch the same contact id under brand B", async () => {
    const [a] = await db.query<{ id: string }>(`select id from email_boss.contacts where brand_id = $1 and email = 'same@example.com'`, [ids.alpha]);
    const r = await suppressContact(db, { contactId: a.id, brandId: ids.beta, status: "unsubscribed" });
    expect(r.found).toBe(false);
  });

  it("the database rejects cross-brand enrollments, tags and sends", async () => {
    const [betaContact] = await db.query<{ id: string }>(`select id from email_boss.contacts where brand_id = $1 limit 1`, [ids.beta]);
    const [alphaSeq] = await db.query<{ id: string }>(`select id from email_boss.sequences where brand_id = $1 limit 1`, [ids.alpha]);
    const [alphaTag] = await db.query<{ id: string }>(`select id from email_boss.tags where brand_id = $1 limit 1`, [ids.alpha]);
    // claim the row belongs to alpha (matches the sequence) -> contact FK fails
    await expect(
      db.query(`insert into email_boss.enrollments (brand_id, sequence_id, contact_id) values ($1, $2, $3)`, [ids.alpha, alphaSeq.id, betaContact.id]),
    ).rejects.toThrow(/foreign key/);
    // claim it belongs to beta (matches the contact) -> sequence FK fails
    await expect(
      db.query(`insert into email_boss.enrollments (brand_id, sequence_id, contact_id) values ($1, $2, $3)`, [ids.beta, alphaSeq.id, betaContact.id]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      db.query(`insert into email_boss.contact_tags (contact_id, tag_id, brand_id) values ($1, $2, $3)`, [betaContact.id, alphaTag.id, ids.beta]),
    ).rejects.toThrow(/foreign key/);
    const [bc] = await db.query<{ id: string }>(
      `insert into email_boss.broadcasts (brand_id, name, template_id) values ($1, 'x', 'news') returning id`, [ids.alpha],
    );
    await expect(
      db.query(`insert into email_boss.sends (brand_id, contact_id, kind, broadcast_id, template_id) values ($1, $2, 'broadcast', $3, 'news')`, [ids.alpha, betaContact.id, bc.id]),
    ).rejects.toThrow(/foreign key/);
    await db.query(`delete from email_boss.broadcasts where id = $1`, [bc.id]);
  });

  it("a broadcast only reaches its own brand's subscribers", async () => {
    await subscribeContact(db, ids.beta, { email: "beta-only@example.com" }, now);
    await db.query(`update email_boss.sends set status = 'canceled' where status = 'queued'`);
    await db.query(`update email_boss.enrollments set status = 'paused'`);
    await db.query(
      `insert into email_boss.broadcasts (brand_id, name, template_id, status, scheduled_at) values ($1, 'Beta news', 'news', 'scheduled', $2::timestamptz)`,
      [ids.beta, now.toISOString()],
    );
    const outbox = new LogProvider(true);
    const s = await runTick(db, { now, manifest, env: TEST_ENV, perSecond: 0, resolveProvider: () => outbox });
    expect(s.broadcastsMaterialized).toBe(1);
    const to = outbox.outbox.map((m) => m.to).sort();
    expect(to).toEqual(["beta-only@example.com", "same@example.com"]);
    expect(outbox.outbox.every((m) => m.from.includes("@beta.example") && m.html.includes("123 Beta Street"))).toBe(true);
    // the unsubscribe link in each email resolves to a beta contact
    for (const m of outbox.outbox) {
      const t = decodeURIComponent(/t=([^>]+)>/.exec(m.headers["List-Unsubscribe"])![1]);
      expect(verifyUnsubscribeToken(t, unsubscribeSecrets(TEST_ENV))!.brandId).toBe(ids.beta);
    }
  });

  it("an API key only authenticates its own brand", async () => {
    const a = generateBrandApiKey("alpha");
    const b = generateBrandApiKey("beta");
    await db.query(`update email_boss.brands set api_key_hash = $2 where slug = $1`, ["alpha", a.hash]);
    await db.query(`update email_boss.brands set api_key_hash = $2 where slug = $1`, ["beta", b.hash]);
    expect((await authenticateBrand(db, a.key))?.slug).toBe("alpha");
    expect((await authenticateBrand(db, b.key))?.slug).toBe("beta");
    // alpha's secret with beta's slug prefix -> rejected
    expect(await authenticateBrand(db, a.key.replace("eb_alpha_", "eb_beta_"))).toBeNull();
    expect(await authenticateBrand(db, "garbage")).toBeNull();
  });

  it("RLS is enabled on every table and the API roles have no access", async () => {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'email_boss' and c.relkind = 'r' order by 1`,
    );
    expect(rls.length).toBe(10);
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
    const policies = await db.query(`select 1 from pg_policies where schemaname = 'email_boss'`);
    expect(policies).toHaveLength(0);
    const grants = await db.query<{ ok: boolean }>(
      `select has_schema_privilege('anon', 'email_boss', 'USAGE') or has_schema_privilege('authenticated', 'email_boss', 'USAGE') as ok`,
    );
    expect(grants[0].ok).toBe(false);
  });
});
