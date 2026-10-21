import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seed, TEST_ENV } from "./helpers/db";
import type { Db } from "@/lib/db";
import { subscribeContact } from "@/lib/engine/contacts";
import { runTick } from "@/lib/engine/runner";
import { handleSesEvent } from "@/lib/engine/ses-events";
import { inactiveReport, tagInactive } from "@/lib/engine/reports";
import { LogProvider } from "@/lib/providers/log";
import { resendToSesEvent, signSvixForTest, verifySvix } from "@/lib/resend-webhook";
import type { Manifest } from "@/lib/brands/schema";

const SECRET = "whsec_" + Buffer.from("super-secret-key-for-tests").toString("base64");

describe("Resend webhook signatures", () => {
  const now = new Date("2026-10-21T20:00:00Z");
  const ts = String(Math.floor(now.getTime() / 1000));
  const body = '{"type":"email.bounced","data":{"email_id":"x"}}';
  const sig = signSvixForTest(SECRET, "msg_1", ts, body);

  it("accepts valid and rejects tampered / stale / unsigned", () => {
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: `v1,bogus ${sig}` }, body, now)).toBe(true);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, body + " ", now)).toBe(false);
    expect(verifySvix(SECRET, { id: "msg_2", timestamp: ts, signature: sig }, body, now)).toBe(false);
    expect(verifySvix(SECRET, { id: "msg_1", timestamp: ts, signature: sig }, body, new Date(now.getTime() + 10 * 60_000))).toBe(false);
    expect(verifySvix(undefined, { id: "msg_1", timestamp: ts, signature: sig }, body, now)).toBe(false);
  });

  it("maps Resend events to the shared handler shape", () => {
    expect(resendToSesEvent({ type: "email.bounced", data: { email_id: "e1", to: ["a@b.co"], bounce: { type: "Transient" } } })?.bounce?.bounceType).toBe("Transient");
    expect(resendToSesEvent({ type: "email.bounced", data: { email_id: "e1", to: ["a@b.co"] } })?.bounce?.bounceType).toBe("Permanent");
    expect(resendToSesEvent({ type: "email.complained", data: { email_id: "e1", to: ["a@b.co"] } })?.eventType).toBe("Complaint");
    expect(resendToSesEvent({ type: "email.sent", data: { email_id: "e1" } })).toBeNull();
  });
});

describe("Resend events + inactive report (database)", () => {
  let db: Db;
  let ids: Record<string, string>;
  let manifest: Manifest;
  const t0 = new Date("2026-01-01T17:00:00Z");

  beforeEach(async () => {
    ({ db } = await createTestDb());
    ({ ids, manifest } = await seed(db));
  });

  it("a Resend bounce suppresses the contact in its brand", async () => {
    await subscribeContact(db, ids.alpha, { email: "r@example.com", tags: ["lead"] }, t0);
    await runTick(db, { now: t0, manifest, env: TEST_ENV, perSecond: 0, resolveProvider: () => new LogProvider(true) });
    const [s] = await db.query<{ provider_message_id: string }>(`select provider_message_id from email_boss.sends limit 1`);
    const ev = resendToSesEvent({ type: "email.bounced", data: { email_id: s.provider_message_id, to: ["r@example.com"] } })!;
    expect((await handleSesEvent(db, ev, "resend:msg_9", t0)).suppressed).toBe(1);
    const [c] = await db.query<{ status: string }>(`select status from email_boss.contacts where email = 'r@example.com'`);
    expect(c.status).toBe("bounced");
  });

  it("reports engaged / inactive / too early / no data and tags the inactive ones", async () => {
    const outbox = new LogProvider(true);
    const tick = (now: Date) => runTick(db, { now, manifest, env: TEST_ENV, perSecond: 0, resolveProvider: () => outbox });
    await subscribeContact(db, ids.alpha, { email: "engaged@example.com", tags: ["lead"] }, t0);
    await subscribeContact(db, ids.alpha, { email: "quiet@example.com", tags: ["lead"] }, t0);
    await tick(t0);
    const later = new Date("2026-10-15T17:00:00Z");
    await subscribeContact(db, ids.alpha, { email: "new@example.com", tags: ["lead"] }, later);
    await tick(later);
    await subscribeContact(db, ids.alpha, { email: "imported@example.com" }, later);
    const [s] = await db.query<{ id: string; contact_id: string }>(
      `select s.id, s.contact_id from email_boss.sends s join email_boss.contacts c on c.id = s.contact_id where c.email = 'engaged@example.com' limit 1`,
    );
    await db.query(
      `insert into email_boss.events (brand_id, contact_id, send_id, type, occurred_at) values ($1, $2, $3, 'open', '2026-09-01T00:00:00Z')`,
      [ids.alpha, s.contact_id, s.id],
    );
    const now = new Date("2026-10-21T17:00:00Z");
    const r = await inactiveReport(db, ids.alpha, 180, now);
    expect(r).toEqual({ days: 180, subscribed: 4, engaged: 1, inactive: 1, tooEarly: 1, noData: 1 });
    expect(await tagInactive(db, ids.alpha, 180, "inactive:180d", now)).toBe(1);
    const tagged = await db.query<{ email: string }>(
      `select c.email from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id join email_boss.contacts c on c.id = ct.contact_id where t.name = 'inactive:180d'`,
    );
    expect(tagged).toEqual([{ email: "quiet@example.com" }]);
    // beta untouched
    expect((await inactiveReport(db, ids.beta, 180, now)).subscribed).toBe(0);
  });
});

describe("pg_cron helper", () => {
  it("exists, validates the URL and refuses to run without pg_cron/pg_net", async () => {
    const { db } = await createTestDb();
    await expect(db.query(`select email_boss.enable_cron_tick('http://insecure/api/cron/tick')`)).rejects.toThrow(/https/);
    await expect(db.query(`select email_boss.enable_cron_tick('https://eb.example.com/api/cron/tick')`)).rejects.toThrow(/pg_cron/);
    await db.query(`select email_boss.disable_cron_tick()`); // no-op without pg_cron
    const [g] = await db.query<{ ok: boolean }>(`select has_function_privilege('anon', 'email_boss.enable_cron_tick(text, text)', 'EXECUTE') as ok`);
    expect(g.ok).toBe(false);
  });
});
