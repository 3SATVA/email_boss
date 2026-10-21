import { z } from "zod";
import { parseDelay } from "../engine/schedule";

/** brands/<slug>/brand.json */
export const brandConfigSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    name: z.string().min(1),
    from_name: z.string().min(1),
    from_email: z.string().email().transform((s) => s.toLowerCase()),
    reply_to: z.string().email().optional(),
    sending_domain: z.string().min(3).transform((s) => s.toLowerCase()),
    physical_address: z.string().min(10, "CAN-SPAM requires a real postal address"),
    timezone: z.string().default("America/Los_Angeles"),
    provider: z.enum(["ses", "resend", "log"]).optional(),
    ses_configuration_set: z.string().optional(),
    links_base_url: z.string().url().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const domain = b.from_email.split("@")[1];
    if (domain !== b.sending_domain && !domain.endsWith("." + b.sending_domain)) {
      ctx.addIssue({ code: "custom", message: `from_email must be on sending_domain ${b.sending_domain}` });
    }
  });
export type BrandConfig = z.infer<typeof brandConfigSchema>;

const delaySchema = z.union([z.string(), z.number().int().nonnegative()]).transform((v, ctx) => {
  try {
    return parseDelay(v);
  } catch (e) {
    ctx.addIssue({ code: "custom", message: (e as Error).message });
    return z.NEVER;
  }
});

const tagName = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_:./-]{0,79}$/, "tags: lowercase letters, digits and _ : . / -"));

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tag_added"), tag: tagName }).strict(),
  z.object({ type: z.literal("signup_source"), source: z.string().min(1) }).strict(),
  z.object({ type: z.literal("manual") }).strict(),
  z
    .object({
      type: z.literal("date"),
      /** key in contact.custom_fields holding an ISO date (YYYY-MM-DD) */
      field: z.string().regex(/^[a-z0-9_]{1,60}$/),
      /** days relative to the date: -7 = a week before, 0 = on the day */
      offset_days: z.number().int().default(0),
      /** repeat every year (birthdays, anniversaries) */
      annual: z.boolean().default(false),
    })
    .strict(),
]);
export type SequenceTrigger = z.infer<typeof triggerSchema>;

/** brands/<slug>/sequences/<key>.json */
export const sequenceSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    name: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(["active", "paused", "archived"]).default("paused"),
    trigger: triggerSchema,
    allow_reenroll: z.boolean().default(false),
    /** contact leaves the sequence as soon as it has any of these tags */
    exit_tags: z.array(tagName).default([]),
    steps: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
            /** wait after the previous step (or after enrollment for the first step). "0", "2h", "3d", "1d 12h" */
            delay: delaySchema,
            template: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
            subject: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const st of s.steps) {
      if (seen.has(st.key)) ctx.addIssue({ code: "custom", message: `duplicate step key ${st.key}` });
      seen.add(st.key);
    }
  });
export type SequenceDef = z.infer<typeof sequenceSchema>;

export interface TemplateDef {
  id: string;
  subject: string;
  preheader?: string;
  html: string;
  /** optional hand-written plain-text part; otherwise generated from html */
  text?: string;
}

export interface BrandBundle {
  config: BrandConfig;
  partials: Record<string, string>;
  templates: Record<string, TemplateDef>;
  sequences: SequenceDef[];
}

export interface Manifest {
  generated_at: string;
  brands: Record<string, BrandBundle>;
}
