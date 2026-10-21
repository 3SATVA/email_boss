import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, seed, TEST_ENV } from "./helpers/db";
import type { Db } from "@/lib/db";
import { subscribeContact } from "@/lib/engine/contacts";
import { runTick } from "@/lib/engine/runner";
import { handleSesEvent } from "@/lib/engine/ses-events";
import { LogProvider } from "@/lib/providers/log";
import { buildSesCommandInput } from "@/lib/providers/ses";
import { chooseProviderName } from "@/lib/providers";
import { isTrustedCertUrl, stringToSign, verifySnsMessage, type SnsMessage } from "@/lib/sns";
import type { Manifest } from "@/lib/brands/schema";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const TOPIC = "arn:aws:sns:us-west-2:123456789012:email-boss-events";
const CERT = "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-abc.pem";

function signed(m: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL">, version: "1" | "2" = "2"): SnsMessage {
  const full = { ...m, SignatureVersion: version, SigningCertURL: CERT, Signature: "" } as SnsMessage;
  full.Signature = crypto.createSign(version === "2" ? "RSA-SHA256" : "RSA-SHA1").update(stringToSign(full)).sign(privateKey, "base64");
  return full;
}

describe("SNS signature verification", () => {
  const base = { Type: "Notification" as const, MessageId: "m-1", TopicArn: TOPIC, Message: "{}", Timestamp: new Date().toISOString() };
  const opts = { allowedTopicArns: [TOPIC], fetchCert: async () => pem };

  it("accepts a correctly signed message (v1 and v2)", async () => {
    expect(await verifySnsMessage(signed(base), opts)).toEqual({ ok: true });
    expect(await verifySnsMessage(signed(base, "1"), opts)).toEqual({ ok: true });
  });

  it("rejects tampering, foreign topics, bad cert hosts and stale messages", async () => {
    const m = signed(base);
    expect((await verifySnsMessage({ ...m, Message: '{"x":1}' }, opts)).ok).toBe(false);
    expect((await verifySnsMessage(m, { ...opts, allowedTopicArns: ["arn:other"] })).ok).toBe(false);
    expect((await verifySnsMessage({ ...m, SigningCertURL: "https://evil.example.com/x.pem" }, opts)).ok).toBe(false);
    expect((await verifySnsMessage(signed({ ...base, Timestamp: "2020-01-01T00:00:00Z" }), opts)).ok).toBe(false);
    expect(isTrustedCertUrl("http://sns.us-west-2.amazonaws.com/a.pem")).toBe(false);
    expect(isTrustedCertUrl("https://sns.us-west-2.amazonaws.com.evil.com/a.pem")).toBe(false);
  });
});

describe("SES bounce / complaint handling", () => {
  let db: Db;
  let ids: Record<string, string>;
  let manifest: Manifest;
  let outbox: LogProvider;
  const now = new Date("2026-10-21T17:00:00Z");

  beforeEach(async () => {
    ({ db } = await createTestDb());
    ({ ids, manifest } = await seed(db));
    outbox = new LogProvider(true);
  });

  async function sendOne(email: string) {
    await subscribeContact(db, ids.alpha, { email, tags: ["lead"] }, now);
    await subscribeContact(db, ids.beta, { email, tags: ["lead"] }, now);
    await runTick(db, { now, manifest, env: TEST_ENV, perSecond: 0, resolveProvider: () => outbox });
    const [s] = await db.query<{ provider_message_id: string }>(
      `select s.provider_message_id from email_boss.sends s join email_boss.contacts c on c.id = s.contact_id
        where c.email = $1 and s.brand_id = $2`, [email, ids.alpha],
    );
    return s.provider_message_id;
  }

  const status = async (email: string) =>
    db.query<{ slug: string; status: string }>(
      `select b.slug, c.status from email_boss.contacts c join email_boss.brands b on b.id = c.brand_id where c.email = $1 order by 1`, [email],
    );

  it("a permanent bounce suppresses only the brand that sent it, idempotently", async () => {
    const mid = await sendOne("gone@example.com");
    const ev = { eventType: "Bounce", mail: { messageId: mid }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "Gone@example.com" }] } };
    expect((await handleSesEvent(db, ev, "sns-1", now)).suppressed).toBe(1);
    expect((await handleSesEvent(db, ev, "sns-1", now)).suppressed).toBe(0); // SNS redelivery
    expect(await status("gone@example.com")).toEqual([{ slug: "alpha", status: "bounced" }, { slug: "beta", status: "subscribed" }]);
    const events = await db.query(`select 1 from email_boss.events where type = 'bounce'`);
    expect(events).toHaveLength(1);
  });

  it("a transient bounce is only logged", async () => {
    const mid = await sendOne("full@example.com");
    await handleSesEvent(db, { notificationType: "Bounce", mail: { messageId: mid }, bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "full@example.com" }] } }, "sns-2", now);
    expect((await status("full@example.com"))[0].status).toBe("subscribed");
    expect(await db.query(`select 1 from email_boss.events where type = 'soft_bounce'`)).toHaveLength(1);
  });

  it("a complaint suppresses and exits the sequence; opens/clicks are recorded", async () => {
    const mid = await sendOne("angry@example.com");
    await handleSesEvent(db, { eventType: "Open", mail: { messageId: mid }, open: {} }, "sns-o", now);
    await handleSesEvent(db, { eventType: "Click", mail: { messageId: mid }, click: { link: "https://x" } }, "sns-c", now);
    await handleSesEvent(db, { eventType: "Complaint", mail: { messageId: mid }, complaint: { complainedRecipients: [{ emailAddress: "angry@example.com" }] } }, "sns-3", now);
    expect((await status("angry@example.com"))[0]).toEqual({ slug: "alpha", status: "complained" });
    const [e] = await db.query<{ status: string }>(
      `select e.status from email_boss.enrollments e join email_boss.sequences s on s.id = e.sequence_id where e.brand_id = $1`, [ids.alpha],
    );
    expect(e.status).toBe("exited");
    const types = await db.query<{ type: string }>(`select type from email_boss.events where brand_id = $1 order by id`, [ids.alpha]);
    expect(types.map((t) => t.type)).toEqual(["subscribe", "sent", "open", "click", "complaint"]);
  });

  it("unknown message ids are ignored (no cross-brand guessing)", async () => {
    const r = await handleSesEvent(db, { eventType: "Bounce", mail: { messageId: "nope" }, bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "x@y.z" }] } }, "sns-4", now);
    expect(r.matched).toBe(false);
  });
});

describe("providers", () => {
  it("never picks a real provider unless SEND_ENABLED=true", () => {
    expect(chooseProviderName("ses", {} as NodeJS.ProcessEnv)).toBe("log");
    expect(chooseProviderName(null, { EMAIL_PROVIDER: "resend" } as unknown as NodeJS.ProcessEnv)).toBe("log");
    expect(chooseProviderName(null, { SEND_ENABLED: "true", EMAIL_PROVIDER: "ses" } as unknown as NodeJS.ProcessEnv)).toBe("ses");
    expect(chooseProviderName("resend", { SEND_ENABLED: "true", EMAIL_PROVIDER: "ses" } as unknown as NodeJS.ProcessEnv)).toBe("resend");
  });

  it("builds an SES v2 request with one-click unsubscribe headers and config set", () => {
    const input = buildSesCommandInput({
      from: '"Susana" <hello@yonisync.com>', to: "a@b.co", subject: "s", html: "<p>h</p>", text: "t",
      headers: { "List-Unsubscribe": "<https://x/api/unsubscribe?t=1>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: { brand: "yonisync", send_id: "abc.def" }, configurationSet: "yonisync-marketing",
    });
    expect(input.ConfigurationSetName).toBe("yonisync-marketing");
    expect(input.Content.Simple.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://x/api/unsubscribe?t=1>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
    expect(input.EmailTags).toEqual([{ Name: "brand", Value: "yonisync" }, { Name: "send_id", Value: "abc_def" }]);
  });
});
