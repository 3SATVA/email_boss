import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seed, TEST_ENV } from "./helpers/db";
import type { Db } from "@/lib/db";
import { addTags, subscribeContact, suppressContact } from "@/lib/engine/contacts";
import { runTick, type TickOptions } from "@/lib/engine/runner";
import { LogProvider } from "@/lib/providers/log";
import { PermanentSendError, type EmailProvider } from "@/lib/providers";
import type { Manifest } from "@/lib/brands/schema";

let db: Db;
let ids: Record<string, string>;
let manifest: Manifest;
let outbox: LogProvider;
const T0 = new Date("2026-10-21T17:00:00Z"); // 10:00 PT
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const tick = (now: Date, extra: Partial<TickOptions> = {}) =>
  runTick(db, { now, manifest, env: TEST_ENV, perSecond: 0, resolveProvider: () => outbox, ...extra });

beforeEach(async () => {
  ({ db } = await createTestDb());
  ({ ids, manifest } = await seed(db));
  outbox = new LogProvider(true);
});

describe("sequence scheduling", () => {
  it("tag trigger: sends step 1 now, step 2 three days later, then completes", async () => {
    const r = await subscribeContact(db, ids.alpha, { email: "maya@example.com", first_name: "Maya", tags: ["lead"], custom_fields: { fertility_type: "Kidney Yin" } }, T0);
    expect(r.enrolled).toEqual(["welcome"]);

    let s = await tick(T0);
    expect(s.stepsQueued).toBe(1);
    expect(s.sent).toBe(1);
    expect(outbox.outbox[0].subject).toBe("Welcome Maya to Brand Alpha");
    expect(outbox.outbox[0].html).toContain("your type is Kidney Yin");
    expect(outbox.outbox[0].headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(outbox.outbox[0].headers["List-Unsubscribe"]).toMatch(/^<https:\/\/mail\.example\.test\/api\/unsubscribe\?t=v1\./);

    // nothing is due 2 days later
    s = await tick(at(2 * 1440));
    expect(s.sent).toBe(0);

    // 3 days after step 1
    s = await tick(at(3 * 1440));
    expect(s.sent).toBe(1);
    expect(outbox.outbox[1].subject).toBe("A follow-up from Brand Alpha");
    expect(s.enrollmentsCompleted).toBe(1);

    // running again never re-sends
    s = await tick(at(10 * 1440));
    expect(s.sent).toBe(0);
    expect(outbox.outbox).toHaveLength(2);
  });

  it("signup_source trigger honours the first-step delay and only fires on signup", async () => {
    await subscribeContact(db, ids.alpha, { email: "q@example.com", source: "quiz" }, T0);
    expect((await tick(at(59))).sent).toBe(0);
    expect((await tick(at(60))).sent).toBe(1);
    // a later form submit by the same person does not re-trigger the signup sequence
    const again = await subscribeContact(db, ids.alpha, { email: "q@example.com", source: "quiz" }, at(100));
    expect(again.enrolled).toEqual([]);
  });

  it("re-adding an existing tag does not re-enroll", async () => {
    await subscribeContact(db, ids.alpha, { email: "t@example.com", tags: ["lead"] }, T0);
    const r = await subscribeContact(db, ids.alpha, { email: "t@example.com", tags: ["lead"] }, at(5));
    expect(r.tagsAdded).toEqual([]);
    expect(r.enrolled).toEqual([]);
  });

  it("unsubscribing exits the sequence and cancels queued mail", async () => {
    const r = await subscribeContact(db, ids.alpha, { email: "u@example.com", tags: ["lead"] }, T0);
    await tick(T0);
    await suppressContact(db, { contactId: r.contactId, brandId: ids.alpha, status: "unsubscribed", now: at(1) });
    const s = await tick(at(4 * 1440));
    expect(s.sent).toBe(0);
    const [e] = await db.query<{ status: string; exit_reason: string }>(`select status, exit_reason from email_boss.enrollments where contact_id = $1`, [r.contactId]);
    expect(e).toEqual({ status: "exited", exit_reason: "contact_unsubscribed" });
  });

  it("an exit tag stops the sequence", async () => {
    const r = await subscribeContact(db, ids.alpha, { email: "buyer@example.com", tags: ["lead"] }, T0);
    await tick(T0);
    await addTags(db, ids.alpha, r.contactId, ["customer"]);
    const s = await tick(at(3 * 1440));
    expect(s.sent).toBe(0);
    expect(s.enrollmentsExited).toBe(1);
  });

  it("paused sequences don't enroll; paused brands don't send", async () => {
    await db.query(`update email_boss.sequences set status = 'paused' where brand_id = $1 and key = 'welcome'`, [ids.alpha]);
    const r = await subscribeContact(db, ids.alpha, { email: "p@example.com", tags: ["lead"] }, T0);
    expect(r.enrolled).toEqual([]);
    await db.query(`update email_boss.sequences set status = 'active'`);
    await db.query(`update email_boss.brands set status = 'paused' where id = $1`, [ids.beta]);
    await subscribeContact(db, ids.beta, { email: "p@example.com", tags: ["lead"] }, T0);
    expect((await tick(T0)).sent).toBe(0);
  });

  it("enforces the per-brand daily warm-up cap (brand-local day)", async () => {
    await db.query(`update email_boss.brands set daily_cap_override = null, warmup_started_on = '2026-10-21'`);
    for (let i = 0; i < 60; i++) await subscribeContact(db, ids.alpha, { email: `w${i}@example.com`, tags: ["lead"] }, T0);
    const s = await tick(T0, { warmupSchedule: [50, 100] });
    expect(s.sent).toBe(50);
    expect(s.capped.alpha).toEqual({ cap: 50, sentToday: 50 });
    // later the same PT day: still capped
    expect((await tick(at(6 * 60), { warmupSchedule: [50, 100] })).sent).toBe(0);
    // next PT day (Oct 22 00:30 PT = 07:30Z): day index 1, cap 100
    expect((await tick(new Date("2026-10-22T07:30:00Z"), { warmupSchedule: [50, 100] })).sent).toBe(10);
  });

  it("nothing sends before warm-up has started", async () => {
    await db.query(`update email_boss.brands set daily_cap_override = null, warmup_started_on = null`);
    await subscribeContact(db, ids.alpha, { email: "cold@example.com", tags: ["lead"] }, T0);
    const s = await tick(T0);
    expect(s.sent).toBe(0);
    expect(s.capped.alpha.cap).toBe(0);
  });

  it("retries transient provider errors, gives up on permanent ones", async () => {
    let calls = 0;
    const flaky: EmailProvider = { name: "log", send: async () => { calls++; throw new Error("throttled"); } };
    await subscribeContact(db, ids.alpha, { email: "r@example.com", tags: ["lead"] }, T0);
    let s = await tick(T0, { resolveProvider: () => flaky });
    expect(s.retried).toBe(1);
    s = await tick(at(10), { resolveProvider: () => flaky });
    expect(s.retried).toBe(1);
    s = await tick(at(40), { resolveProvider: () => flaky });
    expect(s.failed).toBe(1);
    expect(calls).toBe(3);

    const hard: EmailProvider = { name: "log", send: async () => { throw new PermanentSendError("MessageRejected"); } };
    await subscribeContact(db, ids.alpha, { email: "r2@example.com", tags: ["lead"] }, T0);
    s = await tick(at(41), { resolveProvider: () => hard });
    expect(s.failed).toBe(1);
  });

  it("date trigger: annual birthday enrolls once per year", async () => {
    await subscribeContact(db, ids.alpha, { email: "bday@example.com", custom_fields: { birthday: "1990-10-21" } }, T0);
    await subscribeContact(db, ids.alpha, { email: "other@example.com", custom_fields: { birthday: "1990-11-02" } }, T0);
    await subscribeContact(db, ids.alpha, { email: "bad@example.com", custom_fields: { birthday: "1990-02-31" } }, T0);
    let s = await tick(T0);
    expect(s.dateEnrolled).toBe(1);
    expect(outbox.outbox.map((m) => m.to)).toEqual(["bday@example.com"]);
    s = await tick(at(60));
    expect(s.dateEnrolled).toBe(0);
    s = await tick(new Date("2027-10-21T17:00:00Z"));
    expect(s.dateEnrolled).toBe(1);
  });

  it("refuses to send while the brand address is a placeholder", async () => {
    await db.query(`update email_boss.brands set physical_address = 'REPLACE_ME: real address here' where id = $1`, [ids.alpha]);
    await subscribeContact(db, ids.alpha, { email: "addr@example.com", tags: ["lead"] }, T0);
    const s = await tick(T0);
    expect(s.sent).toBe(0);
    expect(s.failed).toBe(1);
  });
});

describe("subscribe rules", () => {
  it("only an explicit new opt-in re-subscribes; bounced/complained never come back", async () => {
    const r = await subscribeContact(db, ids.alpha, { email: "x@example.com" }, T0);
    await suppressContact(db, { contactId: r.contactId, brandId: ids.alpha, status: "unsubscribed" });
    expect((await subscribeContact(db, ids.alpha, { email: "x@example.com" }, at(1))).status).toBe("unsubscribed");
    const back = await subscribeContact(db, ids.alpha, { email: "x@example.com", consent: true, tags: ["lead"] }, at(2));
    expect(back.status).toBe("subscribed");
    expect(back.resubscribed).toBe(true);
    expect(back.enrolled).toEqual(["welcome"]);

    await suppressContact(db, { contactId: r.contactId, brandId: ids.alpha, status: "bounced" });
    expect((await subscribeContact(db, ids.alpha, { email: "x@example.com", consent: true }, at(3))).status).toBe("bounced");
    // suppression can't be downgraded
    await suppressContact(db, { contactId: r.contactId, brandId: ids.alpha, status: "unsubscribed" });
    const [c] = await db.query<{ status: string }>(`select status from email_boss.contacts where id = $1`, [r.contactId]);
    expect(c.status).toBe("bounced");
  });

  it("rejects bad emails and tags", async () => {
    await expect(subscribeContact(db, ids.alpha, { email: "nope" })).rejects.toThrow(/invalid email/);
    await expect(subscribeContact(db, ids.alpha, { email: "a@b.co", tags: ["!!!"] })).rejects.toThrow(/invalid tag/);
  });
});
