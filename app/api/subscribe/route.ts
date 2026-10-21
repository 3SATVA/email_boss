import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, isDbConfigured } from "@/lib/db";
import { subscribeContact, ValidationError } from "@/lib/engine/contacts";
import { authenticateBrand, bearer, clientIp } from "@/lib/server/brand-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z
  .object({
    email: z.string().min(3).max(254),
    first_name: z.string().max(100).nullish(),
    last_name: z.string().max(100).nullish(),
    tags: z.array(z.string().max(80)).max(25).optional(),
    source: z.string().max(100).nullish(),
    custom_fields: z
      .record(z.string().regex(/^[a-z0-9_]{1,60}$/), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
      .refine((o) => Object.keys(o).length <= 40, "max 40 custom fields")
      .optional(),
    /** true = the person just ticked/submitted an opt-in (required to re-subscribe someone) */
    consent: z.boolean().optional(),
    /** the visitor's IP, when calling from your own server on their behalf */
    ip: z.string().max(45).optional(),
    /** keys of manual-trigger sequences to enroll into */
    enroll: z.array(z.string().max(80)).max(10).optional(),
  })
  .strict();

/**
 * POST /api/subscribe
 * Authorization: Bearer eb_<brand>_<secret>   (server-to-server; never put the key in browser code)
 */
export async function POST(req: Request) {
  if (!isDbConfigured()) return NextResponse.json({ error: "not configured" }, { status: 503 });
  const db = getDb();
  const brand = await authenticateBrand(db, bearer(req.headers));
  if (!brand) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let parsed;
  try {
    parsed = body.safeParse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  }
  const { ip, ...input } = parsed.data;
  try {
    const r = await subscribeContact(db, brand.id, { ...input, consent_ip: ip ?? clientIp(req.headers) });
    return NextResponse.json({
      ok: true,
      contact_id: r.contactId,
      status: r.status,
      created: r.created,
      resubscribed: r.resubscribed,
      tags_added: r.tagsAdded,
      enrolled: r.enrolled,
    });
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("subscribe failed", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
