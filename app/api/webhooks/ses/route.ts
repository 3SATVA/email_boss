import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { handleSesEvent, type SesEvent } from "@/lib/engine/ses-events";
import { isSnsUrl, verifySnsMessage, type SnsMessage } from "@/lib/sns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SES -> SNS -> here. Bounces and complaints suppress the contact (in its own brand only);
 * deliveries/opens/clicks are recorded as events.
 * SNS_TOPIC_ARNS = comma-separated list of allowed topic ARNs.
 */
export async function POST(req: Request) {
  const allowed = (process.env.SNS_TOPIC_ARNS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return NextResponse.json({ error: "SNS_TOPIC_ARNS not set" }, { status: 503 });

  let msg: SnsMessage;
  try {
    msg = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const v = await verifySnsMessage(msg, { allowedTopicArns: allowed });
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 403 });

  if (msg.Type === "SubscriptionConfirmation") {
    if (!msg.SubscribeURL || !isSnsUrl(msg.SubscribeURL)) {
      return NextResponse.json({ error: "untrusted subscribe url" }, { status: 400 });
    }
    const r = await fetch(msg.SubscribeURL);
    return NextResponse.json({ confirmed: r.ok });
  }
  if (msg.Type !== "Notification") return NextResponse.json({ ok: true });

  let ev: SesEvent;
  try {
    ev = JSON.parse(msg.Message);
  } catch {
    return NextResponse.json({ ok: true, ignored: "non-json message" });
  }
  try {
    const r = await handleSesEvent(getDb(), ev, msg.MessageId);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("ses webhook failed", e);
    return NextResponse.json({ error: "internal error" }, { status: 500 }); // SNS will retry
  }
}
