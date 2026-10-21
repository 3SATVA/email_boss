import { describe, expect, it } from "vitest";
import { dailyCap, DEFAULT_WARMUP_SCHEDULE, formatDelay, parseDelay } from "@/lib/engine/schedule";

describe("delays", () => {
  it("parses human delays", () => {
    expect(parseDelay("0")).toBe(0);
    expect(parseDelay("immediately")).toBe(0);
    expect(parseDelay("30m")).toBe(30);
    expect(parseDelay("2h")).toBe(120);
    expect(parseDelay("3d")).toBe(4320);
    expect(parseDelay("1d 12h")).toBe(2160);
    expect(parseDelay("1w")).toBe(10080);
    expect(parseDelay(15)).toBe(15);
    expect(() => parseDelay("soon")).toThrow();
    expect(() => parseDelay("3 days")).toThrow();
    expect(() => parseDelay(-1)).toThrow();
    expect(formatDelay(2160)).toBe("1d 12h");
    expect(formatDelay(0)).toBe("immediately");
  });
});

describe("warm-up caps", () => {
  it("sends nothing before warm-up starts, ramps, then plateaus", () => {
    expect(dailyCap({ warmupDayIndex: null, override: null })).toBe(0);
    expect(dailyCap({ warmupDayIndex: 0, override: null })).toBe(50);
    expect(dailyCap({ warmupDayIndex: 3, override: null })).toBe(DEFAULT_WARMUP_SCHEDULE[3]);
    expect(dailyCap({ warmupDayIndex: 999, override: null })).toBe(DEFAULT_WARMUP_SCHEDULE.at(-1));
    expect(dailyCap({ warmupDayIndex: 0, override: 5 })).toBe(5);
    for (let i = 1; i < DEFAULT_WARMUP_SCHEDULE.length; i++) {
      expect(DEFAULT_WARMUP_SCHEDULE[i]).toBeGreaterThan(DEFAULT_WARMUP_SCHEDULE[i - 1]);
    }
  });
});
