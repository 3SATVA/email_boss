import Link from "next/link";
import { manifest } from "@/lib/brands/registry";
import { requireAdmin } from "@/lib/server/admin";
import { loadBrandStats } from "@/lib/server/dashboard";
import { sendingEnabled } from "@/lib/providers";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await requireAdmin();
  let stats: Awaited<ReturnType<typeof loadBrandStats>> | null = null;
  let error: string | null = null;
  try {
    stats = await loadBrandStats();
  } catch (e) {
    error = (e as Error).message;
  }
  const dbBySlug = new Map((stats?.brands ?? []).map((b) => [b.brand.slug, b]));
  const slugs = [...new Set([...Object.keys(manifest.brands), ...dbBySlug.keys()])].sort();

  return (
    <main>
      <h1>Brands</h1>
      {!sendingEnabled() && <p className="warn">Dry-run mode: SEND_ENABLED is not &quot;true&quot;, so nothing is actually emailed.</p>}
      {stats && !stats.configured && <p className="warn">Database not configured (SUPABASE_DB_URL). Showing brand definitions only.</p>}
      {error && <p className="warn">Database error: {error}</p>}
      <table className="grid">
        <thead>
          <tr><th>Brand</th><th>Status</th><th>Subscribed</th><th>Unsubscribed</th><th>Bounced</th><th>Complained</th><th>Sent today / cap</th><th>Sequences</th></tr>
        </thead>
        <tbody>
          {slugs.map((slug) => {
            const db = dbBySlug.get(slug);
            const def = manifest.brands[slug];
            return (
              <tr key={slug}>
                <td><Link href={`/admin/brands/${slug}`}>{def?.config.name ?? db?.brand.name ?? slug}</Link><div className="muted">{def?.config.from_email ?? db?.brand.from_email}</div></td>
                <td><span className={`pill ${db?.brand.status ?? ""}`}>{db?.brand.status ?? "not synced"}</span></td>
                <td>{db?.byStatus.subscribed ?? 0}</td>
                <td>{db?.byStatus.unsubscribed ?? 0}</td>
                <td>{db?.byStatus.bounced ?? 0}</td>
                <td>{db?.byStatus.complained ?? 0}</td>
                <td>{db ? `${db.cap.sentToday} / ${db.cap.cap}` : "-"}{db && !db.brand.warmup_started_on && <div className="muted">warm-up not started</div>}</td>
                <td>{def?.sequences.length ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted">Manifest built {manifest.generated_at}</p>
    </main>
  );
}
