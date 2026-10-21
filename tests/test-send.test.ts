import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBrandDir } from "@/lib/brands/load";
import { testRecipients, testSend } from "@/lib/engine/test-send";
import { LogProvider } from "@/lib/providers/log";

const bundle = loadBrandDir(path.resolve("tests/fixtures/brands/alpha"));
const env = { TEST_RECIPIENTS: "Me@Example.com, other@example.com", PUBLIC_BASE_URL: "https://eb.test" } as unknown as NodeJS.ProcessEnv;

describe("test sends", () => {
  it("parses the allowlist", () => {
    expect([...testRecipients(env)]).toEqual(["me@example.com", "other@example.com"]);
  });

  it("renders the real template to an allowlisted address via the log provider", async () => {
    const log = new LogProvider(true);
    const r = await testSend({ bundle, templateId: "welcome", to: "ME@example.com", env, custom: { fertility_type: "Kidney Yin" }, firstName: "Maya", resolve: () => log });
    expect(r.provider).toBe("log");
    expect(r.subject).toBe("[TEST] Welcome Maya to Brand Alpha");
    expect(log.outbox[0].to).toBe("me@example.com");
    expect(log.outbox[0].from).toBe('"Alpha Team" <hello@alpha.example>');
    expect(log.outbox[0].html).toContain("your type is Kidney Yin");
    expect(log.outbox[0].html).toContain("123 Alpha Street");
    expect(log.outbox[0].headers["X-Email-Boss-Test"]).toBe("1");
  });

  it("refuses addresses outside TEST_RECIPIENTS, an empty allowlist, unknown templates and real providers while disabled", async () => {
    const log = new LogProvider(true);
    await expect(testSend({ bundle, templateId: "welcome", to: "stranger@example.com", env, resolve: () => log })).rejects.toThrow(/not in TEST_RECIPIENTS/);
    await expect(testSend({ bundle, templateId: "welcome", to: "me@example.com", env: {} as NodeJS.ProcessEnv, resolve: () => log })).rejects.toThrow(/empty/);
    await expect(testSend({ bundle, templateId: "nope", to: "me@example.com", env, resolve: () => log })).rejects.toThrow(/not found/);
    await expect(testSend({ bundle, templateId: "welcome", to: "me@example.com", env, provider: "ses", resolve: () => log })).rejects.toThrow(/SEND_ENABLED/);
    expect(log.outbox).toHaveLength(0);
  });
});
