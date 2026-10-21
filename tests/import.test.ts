import fs from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seed } from "./helpers/db";
import type { Db } from "@/lib/db";
import { importContacts, mapStatus, parseContactsCsv, parseDate } from "@/lib/import/csv";
import { subscribeContact, suppressContact } from "@/lib/engine/contacts";

const csv = fs.readFileSync("tests/fixtures/constant-contact.csv", "utf8");

describe("CSV parsing", () => {
  it("normalizes, dedupes, maps statuses and reports problems", () => {
    const { contacts, stats } = parseContactsCsv(csv, { extraTags: ["imported:cc"] });
    expect(stats.rows).toBe(8);
    expect(stats.columns.email).toBe("Email address");
    expect(stats.format).toBe("constant_contact");
    expect(stats.columns.status).toEqual(["Email status"]);
    expect(stats.columns.tags).toEqual(["Email Lists"]);
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

describe("systeme.io export format", () => {
  const systeme = [
    '"Email","First name","Last name","Street address","Street number","Neighborhood","Postal code","City","State/Province","Country","Phone number","Company name","Tax number","Tag","Date Registered"',
    '"Ana@Example.com","Ana","Lopez","","","","","","","Peru","","","","Webinar Email Collected,Quiz","2026-02-16 18:26:17 (UTC-8)"',
    '"ben@example.com","Ben","","","","","","","","","+1 555","","","freebie-checklist-optin","2025-07-16 17:18:41 (UTC-7)"',
    '"cat@example.com","","","","","","","","","","","","","unsubscribed","2026-01-01 00:00:00 (UTC+5:30)"',
  ].join("\n");

  it("detects the format, maps Tag -> lowercase tags and Date Registered -> consent date", () => {
    const { contacts, stats } = parseContactsCsv(systeme, { suppressTags: ["unsubscribed"] });
    expect(stats.format).toBe("systeme");
    expect(stats.columns).toMatchObject({ email: "Email", tags: ["Tag"], consent_at: "Date Registered", status: [] });
    const ana = contacts.find((c) => c.email === "ana@example.com")!;
    expect(ana.tags.sort()).toEqual(["quiz", "webinar-email-collected"]);
    expect(ana.consent_at).toBe("2026-02-17T02:26:17.000Z");
    expect(ana.custom_fields).toEqual({ country: "Peru" });
    expect(contacts.find((c) => c.email === "ben@example.com")!.consent_at).toBe("2025-07-17T00:18:41.000Z");
    const cat = contacts.find((c) => c.email === "cat@example.com")!;
    expect(cat.consent_at).toBe("2025-12-31T18:30:00.000Z");
    expect(cat.status).toBe("unsubscribed"); // via --suppress-tag
    expect(stats.tagCounts).toEqual({ quiz: 1, "webinar-email-collected": 1, "freebie-checklist-optin": 1, unsubscribed: 1 });
  });

  it("parses the date formats we expect", () => {
    expect(parseDate("2026-02-16 18:26:17 (UTC-8)")).toBe("2026-02-17T02:26:17.000Z");
    expect(parseDate("2026-02-16 18:26 (GMT+1)")).toBe("2026-02-16T17:26:00.000Z");
    expect(parseDate("2026-02-16 18:26:17")).toBe("2026-02-16T18:26:17.000Z");
    expect(parseDate("10/21/2026 13:05")).toBe("2026-10-21T13:05:00.000Z");
    expect(parseDate("2026-10-21T13:05:00-07:00")).toBe("2026-10-21T20:05:00.000Z");
    expect(parseDate("garbage")).toBeNull();
  });
});

describe("Constant Contact export format", () => {
  const cc = [
    "Email address,First name,Last name,Email permission status,Email Opt-in Date,Email Opt-out Date,Email Lists,Tags,Source Name,Created At",
    "a@example.com,A,One,Permitted,2024-03-01T10:00:00Z,,General Interest;Starseed,vip,Sign-up form,2024-03-01",
    "b@example.com,B,,Unsubscribed,2024-03-01,2025-01-01,General Interest,,Import,2024-03-01",
    "c@example.com,C,,Not set,,,,,Event registration,2024-05-01",
    "d@example.com,D,,Pending confirmation,,,,,Sign-up form,2024-05-01",
    "e@example.com,E,,Implicit,,2025-06-01,,,Import,2024-05-01",
  ].join("\n");

  it("maps permission status, opt-out dates and list memberships safely", () => {
    const { contacts, stats } = parseContactsCsv(cc);
    expect(stats.format).toBe("constant_contact");
    expect(stats.columns.consent_at).toBe("Email Opt-in Date");
    expect(stats.columns.tags).toEqual(["Email Lists", "Tags"]);
    expect(stats.skippedPending).toBe(1);
    expect(stats.noPermission).toBe(1);
    const by = Object.fromEntries(contacts.map((c) => [c.email, c]));
    expect(by["a@example.com"].status).toBe("subscribed");
    expect(by["a@example.com"].tags.sort()).toEqual(["general-interest", "starseed", "vip"]);
    expect(by["a@example.com"].custom_fields).toMatchObject({ source_name: "Sign-up form" });
    expect(by["b@example.com"].status).toBe("unsubscribed");
    expect(by["c@example.com"].status).toBe("unsubscribed"); // "Not set" = never gave permission
    expect(by["e@example.com"].status).toBe("unsubscribed"); // opt-out date wins over "Implicit"
    expect(by["d@example.com"]).toBeUndefined();
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
