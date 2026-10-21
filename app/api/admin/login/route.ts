import { NextResponse } from "next/server";
import { ADMIN_COOKIE, passwordMatches, signAdminSession } from "@/lib/tokens";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const fd = await req.formData();
  const password = String(fd.get("password") ?? "");
  const expected = process.env.ADMIN_PASSWORD;
  await new Promise((r) => setTimeout(r, 400)); // slow down guessing
  if (!passwordMatches(password, expected)) {
    return NextResponse.redirect(new URL("/admin/login?error=1", req.url), 303);
  }
  const res = NextResponse.redirect(new URL("/admin", req.url), 303);
  res.cookies.set(ADMIN_COOKIE, signAdminSession(expected!), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
