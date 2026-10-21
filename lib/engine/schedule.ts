/**
 * Pure scheduling helpers (no I/O) — delays between sequence steps and warm-up caps.
 */

const UNIT_MINUTES: Record<string, number> = { m: 1, min: 1, h: 60, d: 1440, w: 10080 };

/**
 * Parse a step delay into minutes.
 *   0 | "0" | "now" | "immediately" -> 0
 *   "30m", "2h", "3d", "1w", "1d 12h", "1d12h30m"
 *   number -> minutes
 */
export function parseDelay(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 0) throw new Error(`invalid delay: ${input}`);
    return input;
  }
  const s = input.trim().toLowerCase();
  if (s === "0" || s === "now" || s === "immediately") return 0;
  const re = /(\d+)\s*(min|m|h|d|w)/g;
  let total = 0;
  let consumed = "";
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * UNIT_MINUTES[m[2]];
    consumed += m[0];
  }
  if (!consumed || consumed.replace(/\s/g, "") !== s.replace(/\s/g, "")) {
    throw new Error(`invalid delay "${input}" (use e.g. "0", "30m", "2h", "3d", "1d 12h")`);
  }
  return total;
}

export function formatDelay(minutes: number): string {
  if (minutes === 0) return "immediately";
  const parts: string[] = [];
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(" ");
}

export function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

/**
 * Default warm-up schedule: max emails per brand per day, indexed by days since
 * warm-up started. After the last entry the last value applies.
 * Ramps a cold domain to ~50k/day over ~4 weeks, roughly doubling every few days.
 */
export const DEFAULT_WARMUP_SCHEDULE: readonly number[] = [
  50, 100, 150, 250, 400, 600, 800, 1000, 1300, 1600, 2000, 2500, 3000, 3500, 4000, 5000,
  6000, 7500, 9000, 11000, 13000, 15000, 18000, 21000, 25000, 30000, 35000, 40000, 50000,
];

/**
 * Daily cap for a brand.
 * - warm-up not started (null)            -> 0 (nothing sends until you start it)
 * - daily_cap_override set                -> override
 * - otherwise                             -> schedule[dayIndex] (clamped)
 */
export function dailyCap(opts: {
  warmupDayIndex: number | null;
  override: number | null;
  schedule?: readonly number[];
}): number {
  if (opts.override !== null && opts.override !== undefined) return opts.override;
  if (opts.warmupDayIndex === null || opts.warmupDayIndex === undefined || opts.warmupDayIndex < 0) return 0;
  const schedule = opts.schedule ?? DEFAULT_WARMUP_SCHEDULE;
  return schedule[Math.min(opts.warmupDayIndex, schedule.length - 1)];
}

/** Parse a "YYYY-MM-DD" date; returns null for anything else. */
export function parseIsoDate(value: unknown): { y: number; m: number; d: number } | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}
