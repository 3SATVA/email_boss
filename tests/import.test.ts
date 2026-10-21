import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seed } from "./helpers/db";
import type { Db } from "@/lib/db";
import { importContacts, mapStatus, parseContactsCsv } from "@/lib/import/csv";
import { subscribeContact, suppressContact } from "@/lib/engine/contacts";

const csv = fs.readFileSync("tests/fixtures/constant-contact.csv", "utf8");

describe("CSV parsing", () => {
  it("normalizes, dedupes, maps statuses and reports problems", () => {
    const { contacts, stats } = parseContactsCsv(csv, { extraTags: ["imported:cc"] });
    expect(stats.rows).toBe(8);
    expect(stats.columns.email).toBe("Email address");
    expect(stats.columns.status).toBe("Email status");
    expect(stats.columns.tags).toBe("Email Lists");
    expect(stats.invalid).toEqual([{ row: 6, value: "not-an-email" }]);
    expect(stats.skippedPending).toBe(1);
    expect(stats.duplicatesMerged).toBe(1);
    expect(stats.unknownStatuses).toEqual({ "weird-status": 1 });
    expect(stats.byStatus).toEqual({ subscribed: 1, unsubscribed: 2, bounced: 1, complained: 1 });

    const alice = contacts.find((c) => c.email === "alice@example.com")!;
    expect(alice.first_name).toBe("Alice");
    expect(alice.tags.sort()).toEqual(["imported:cc", "starseed-newsletter", "vip", "workshop"]);
    expect(alice.custom_fields).toEqual({ company: "Acme" });
    expect(alice.consent_at).toBe(new Date("2023-04-01").toISOString());
    expect(contacts.find((c) => c.email === "carol@example.com")!.status).toBe("bounced");
    expect(contacts.find((c) => c.email === "frank@example.com")!.status).toBe("unsubscribed");
  });

  it("handles inverted boolean columns safely", () => {
    expect(mapStatus("yes", "Unsubscribed")).toBe("unsubscribed");
    expect(mapStatus("no", "Unsubscribed")).toBe("subscribed");
    expect(mapStatus("", "Status")).toBe("subscribed");
    expect(mapStatus("Hard bounce", "Status")).toBe("bounced");
    expect(mapStatus("Removed", "Status")).toBe("unsubscribed");
    expect(mapStatus("no", "Subscribed")).toBe("unsubscribed");
  });

  it("supports explicit column mapping", () => {
    const { contacts } = parseContactsCsv("Mail Col,Nom\nz@example.com,Zed\n", { columns: { email: "Mail Col", first_name: "Nom" } });
    expect(contacts).toEqual([expect.objectContaining({ email: "z@example.com", first_name: "Zed", status: "subscribed" })]);
    expect(() => parseContactsCsv("foo,bar\n1,2\n")).toThrow(/no email column/);
  });
});

describe("CSV import into the database", () => {
  let db: Db;
  let ids: Record<string, string>;
  beforeAll(async () => {
    ({ db } = await createTestDb());
    ({ ids } = await seed(db));
  });

  it("imports suppressed rows as suppressed and never re-activates anyone", async () => {
    // existing alpha contacts: bob is subscribed (CSV says unsubscribed), alice unsubscribed (CSV says active)
    await subscribeContact(db, ids.alpha, { email: "bob@example.com" });
    const alice = await subscribeContact(db, ids.alpha, { email: "alice@example.com", first_name: "Ally" });
    await suppressContact(db, { contactId: alice.contactId, brandId: ids.alpha, status: "unsubscribed" });

    const { contacts } = parseContactsCsv(csv, { extraTags: ["imported:cc"] });
    const r1 = await importContacts(db, ids.alpha, contacts, { source: "constant_contact", batchSize: 2 });
    expect(r1).toEqual({ inserted: 3, updated: 2 });

    const rows = await db.query<{ email: string; status: string; first_name: string | null }>(
      `select email, status, first_name from email_boss.contacts where brand_id = $1 order by email`, [ids.alpha],
    );
    expect(rows).toEqual([
      { email: "alice@example.com", status: "unsubscribed", first_name: "Ally" },
      { email: "bob@example.com", status: "unsubscribed", first_name: "Bob" },
      { email: "carol@example.com", status: "bounced", first_name: "Carol" },
      { email: "erin@example.com", status: "complained", first_name: "Erin" },
      { email: "frank@example.com", status: "unsubscribed", first_name: "Frank" },
    ]);
    const tags = await db.query<{ name: string }>(
      `select t.name from email_boss.contact_tags ct join email_boss.tags t on t.id = ct.tag_id
         join email_boss.contacts c on c.id = ct.contact_id where c.email = 'alice@example.com' and c.brand_id = $1 order by 1`, [ids.alpha],
    );
    expect(tags.map((t) => t.name)).toEqual(["imported:cc", "starseed-newsletter", "vip", "workshop"]);

    // idempotent re-import, no sequences triggered, beta untouched
    const r2 = await importContacts(db, ids.alpha, contacts, { source: "constant_contact" });
    expect(r2).toEqual({ inserted: 0, updated: 5 });
    const enr = await db.query(`select 1 from email_boss.enrollments`);
    expect(enr).toHaveLength(0);
    const beta = await db.query(`select 1 from email_boss.contacts where brand_id = $1`, [ids.beta]);
    expect(beta).toHaveLength(0);
  });
});
