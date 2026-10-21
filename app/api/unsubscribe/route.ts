import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { suppressContact } from "@/lib/engine/contacts";
import { unsubscribeSecrets, verifyUnsubscribeToken } from "@/lib/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/unsubscribe?t=<token>
 *  - RFC 8058 one-click: mailbox providers POST "List-Unsubscribe=One-Click" here -> 200
 *  - the /unsubscribe confirmation page form also posts here -> 303 to /unsubscribe/done
 * GET never unsubscribes (link scanners prefetch URLs); it redirects to the confirm page.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  let token = url.searchParams.get("t");
  let form: URLSearchParams | null = null;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const fd = await req.formData();
    form = new URLSearchParams();
    for (const [k, v] of fd.entries()) if (typeof v === "string") form.set(k, v);
    token ||= form.get("t");
  } else {
    const text = await req.text();
    form = new URLSearchParams(text);
  }
  const oneClick = form?.get("List-Unsubscribe") === "One-Click";
  const claims = verifyUnsubscribeToken(token, unsubscribeSecrets());
  if (!claims) return new NextResponse("invalid or expired link", { status: 400 });

  try {
    await suppressContact(getDb(), {
      contactId: claims.contactId,
      brandId: claims.brandId,
      status: "unsubscribed",
      data: { method: oneClick ? "one_click" : "page" },
    });
  } catch (e) {
    console.error("unsubscribe failed", e);
    return new NextResponse("temporary error, please try again", { status: 500 });
  }
  if (oneClick) return new NextResponse("unsubscribed", { status: 200 });
  return NextResponse.redirect(new URL("/unsubscribe/done", url), 303);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const t = url.searchParams.get("t") ?? "";
  return NextResponse.redirect(new URL(`/unsubscribe?t=${encodeURIComponent(t)}`, url), 303);
}
