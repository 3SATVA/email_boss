import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { handleSesEvent } from "@/lib/engine/ses-events";
import { resendToSesEvent, verifySvix } from "@/lib/resend-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resend webhook (bounces, complaints, deliveries, opens, clicks). RESEND_WEBHOOK_SECRET = whsec_... */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "RESEND_WEBHOOK_SECRET not set" }, { status: 503 });
  const body = await req.text();
  const id = req.headers.get("svix-id");
  const ok = verifySvix(secret, { id, timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") }, body);
  if (!ok) return NextResponse.json({ error: "bad signature" }, { status: 401 });
  let ev;
  try {
    ev = resendToSesEvent(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!ev) return NextResponse.json({ ok: true, ignored: true });
  try {
    const r = await handleSesEvent(getDb(), ev, `resend:${id}`);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("resend webhook failed", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}
