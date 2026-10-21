import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seed, TEST_ENV } from "./helpers/db";
import type { Db } from "@/lib/db";
import { subscribeContact, suppressContact } from "@/lib/engine/contacts";
import { audienceCounts, createBroadcast, describeSegment, parseAudience } from "@/lib/engine/broadcasts";
import { runTick } from "@/lib/engine/runner";
import { LogProvider } from "@/lib/providers/log";
import type { Manifest } from "@/lib/brands/schema";

describe("audience syntax", () => {
  it("parses everyone / any / all / exclude", () => {
    expect(parseAudience("*")).toEqual({ include_tags: [], exclude_tags: [], match: "any" });
    expect(parseAudience("a, b:c")).toEqual({ include_tags: ["a", "b:c"], exclude_tags: [], match: "any" });
    expect(parseAudience("all:a,b", "x")).toEqual({ include_tags: ["a", "b"], exclude_tags: ["x"], match: "all" });
    expect(() => parseAudience("")).toThrow();
    expect(() => parseAudience("Has Space")).toThrow(/invalid tag/);
    expect(describeSegment(parseAudience("all:a,b", "x"))).toBe("all of: a, b · excluding x");
    expect(describeSegment(parseAudience("*"))).toBe("everyone subscribed");
  });
});

describe("broadcasts", () => {
  let db: Db;
  let ids: Record<string, string>;
  let manifest: Manifest;
  const now = new Date("2026-10-21T17:00:00Z");

  beforeEach(async () => {
    ({ db } = await createTestDb());
    ({ ids, manifest } = await seed(db));
    // no sequences in the way
    await db.query(`update email_boss.sequences set status = 'paused'`);
    await subscribeContact(db, ids.alpha, { email: "a1@example.com", tags: ["vip", "news"] }, now);
    await subscribeContact(db, ids.alpha, { email: "a2@example.com", tags: ["news"] }, now);
    await subscribeContact(db, ids.alpha, { email: "a3@example.com", tags: ["vip"] }, now);
    const gone = await subscribeContact(db, ids.alpha, { email: "a4@example.com", tags: ["news"] }, now);
    await suppressContact(db, { contactId: gone.contactId, brandId: ids.alpha, status: "unsubscribed" });
    await subscribeContact(db, ids.beta, { email: "b1@example.com", tags: ["news"] }, now);
  });

  it("dry-run counts match exactly who receives the broadcast", async () => {
    const cases: [string, string, number, number][] = [
      ["*", "", 3, 1],
      ["news", "", 2, 1],
      ["all:vip,news", "", 1, 0],
      ["news,vip", "vip", 1, 1],
    ];
    for (const [aud, exc, recipients, suppressed] of cases) {
      const seg = parseAudience(aud, exc);
      const c = await audienceCounts(db, ids.alpha, seg);
      expect([aud, c.recipients, c.suppressed, c.subscribedTotal]).toEqual([aud, recipients, suppressed, 3]);
    }
    const typo = await audienceCounts(db, ids.alpha, parseAudience("newz"));
    expect(typo.unknownTags).toEqual(["newz"]);

    const seg = parseAudience("news");
    await createBroadcast(db, { brandId: ids.alpha, name: "Oct news", templateId: "news", segment: seg, scheduledAt: now });
    const outbox = new LogProvider(true);
    await runTick(db, { now, manifest, env: TEST_ENV, perSecond: 0, resolveProvider: () => outbox });
    expect(outbox.outbox.map((m) => m.to).sort()).toEqual(["a1@example.com", "a2@example.com"]);
    const [bc] = await db.query<{ status: string; recipient_count: number }>(`select status, recipient_count from email_boss.broadcasts`);
    expect(bc).toEqual({ status: "sent", recipient_count: 2 });
  });

  it("drafts never send; future schedules wait; canceling stops queued mail", async () => {
    const seg = parseAudience("*");
    await createBroadcast(db, { brandId: ids.alpha, name: "draft", templateId: "news", segment: seg, scheduledAt: null });
    const later = await createBroadcast(db, { brandId: ids.alpha, name: "later", templateId: "news", segment: seg, scheduledAt: new Date("2026-10-22T17:00:00Z") });
    const outbox = new LogProvider(true);
    const opts = { manifest, env: TEST_ENV, perSecond: 0, resolveProvider: () => outbox };
    expect((await runTick(db, { ...opts, now })).sent).toBe(0);

    // queue it with a 1/day cap, then cancel: the rest must not go out
    await db.query(`update email_boss.brands set daily_cap_override = 1 where id = $1`, [ids.alpha]);
    const t = new Date("2026-10-22T17:30:00Z");
    expect((await runTick(db, { ...opts, now: t })).sent).toBe(1);
    await db.query(`update email_boss.broadcasts set status = 'canceled' where id = $1`, [later]);
    await db.query(`update email_boss.brands set daily_cap_override = 100 where id = $1`, [ids.alpha]);
    expect((await runTick(db, { ...opts, now: new Date("2026-10-23T17:30:00Z") })).sent).toBe(0);
    const s = await db.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from email_boss.sends where broadcast_id = $1 group by status order by status`, [later],
    );
    expect(s).toEqual([{ status: "canceled", n: 2 }, { status: "sent", n: 1 }]);
  });
});
