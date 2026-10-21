import Link from "next/link";
import { isAdmin } from "@/lib/server/admin";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await isAdmin();
  return (
    <>
      <header className="top">
        <Link href="/admin" style={{ textDecoration: "none", fontWeight: 700 }}>email_boss</Link>
        {admin && (
          <form method="post" action="/api/admin/logout">
            <button type="submit">Log out</button>
          </form>
        )}
      </header>
      {children}
    </>
  );
}
