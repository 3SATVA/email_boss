import Link from "next/link";
import { notFound } from "next/navigation";
import { getBrandBundle } from "@/lib/brands/registry";
import { formatDelay } from "@/lib/engine/schedule";
import { requireAdmin } from "@/lib/server/admin";
import { fmt, loadBrandDetail } from "@/lib/server/dashboard";
import type { SequenceTrigger } from "@/lib/brands/schema";
import { describeSegment } from "@/lib/engine/broadcasts";

export const dynamic = "force-dynamic";

function describeTrigger(t: SequenceTrigger): string {
  switch (t.type) {
    case "tag_added": return `Tag added: ${t.tag}`;
    case "signup_source": return `Signs up via: ${t.source}`;
    case "manual": return "Manual enrollment";
    case "date": return `Date: ${t.offset_days ? `${Math.abs(t.offset_days)}d ${t.offset_days < 0 ? "before" : "after"} ` : ""}${t.field}${t.annual ? " (yearly)" : ""}`;
  }
}

export default async function BrandPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireAdmin();
  const { slug } = await params;
  const bundle = getBrandBundle(slug);
  let detail: Awaited<ReturnType<typeof loadBrandDetail>> = null;
  let error: string | null = null;
  try {
    detail = await loadBrandDetail(slug);
  } catch (e) {
    error = (e as Error).message;
  }
  if (!bundle && !detail) notFound();

  const enrolled = (key: string, status: string) => detail?.enrollment.find((e) => e.key === key && e.status === status)?.n ?? 0;

  return (
    <main>
      <h1>{bundle?.config.name ?? detail?.brand.name}</h1>
      {error && <p className="warn">Database error: {error}</p>}
      {bundle && /REPLACE_ME/.test(bundle.config.physical_address) && (
        <p className="warn">physical_address in brand.json is still a placeholder. Sending is blocked until it&apos;s a real postal address.</p>
      )}

      <h2>Automations</h2>
      {bundle?.sequences.map((s) => (
        <div className="card" key={s.key}>
          <strong>{s.name}</strong> <span className={`pill ${s.status}`}>{s.status}</span>
          {detail && <span className="muted"> · active {enrolled(s.key, "active")} · completed {enrolled(s.key, "completed")} · exited {enrolled(s.key, "exited")}</span>}
          {s.description && <div className="muted">{s.description}</div>}
          <div className="flow">
            <span className="node trigger">{describeTrigger(s.trigger)}</span>
            {s.steps.map((st) => (
              <span key={st.key} style={{ display: "contents" }}>
                <span className="arrow">→ wait {formatDelay(st.delay)} →</span>
                <Link className="node" href={`/admin/brands/${slug}/templates/${st.template}`}>
                  {bundle.templates[st.template]?.subject ?? st.template}
                </Link>
              </span>
            ))}
          </div>
          {s.exit_tags.length > 0 && <div className="muted">Exits when tagged: {s.exit_tags.join(", ")}</div>}
        </div>
      ))}

      <h2>Templates</h2>
      <ul>
        {Object.values(bundle?.templates ?? {}).map((t) => (
          <li key={t.id}><Link href={`/admin/brands/${slug}/templates/${t.id}`}>{t.id}</Link> <span className="muted">{t.subject}</span></li>
        ))}
      </ul>

      {detail && (
        <>
          <h2>Queue</h2>
          <p>{detail.queue.map((q) => <span key={q.status} className={`pill ${q.status}`} style={{ marginRight: 6 }}>{q.status}: {q.n}</span>)}</p>

          <h2>Broadcasts</h2>
          <table className="grid"><thead><tr><th>Name</th><th>Template</th><th>Status</th><th>Scheduled</th><th>Recipients</th></tr></thead>
            <tbody>{detail.broadcasts.map((b) => (
              <tr key={b.id}><td><Link href={`/admin/brands/${slug}/broadcasts/${b.id}`}>{b.name}</Link><div className="muted">{describeSegment(b.segment)}</div></td><td>{b.template_id}</td><td><span className={`pill ${b.status}`}>{b.status}</span></td><td>{fmt(b.scheduled_at)}</td><td>{b.recipient_count ?? ""}</td></tr>
            ))}</tbody></table>

          <h2>Recent sends</h2>
          <table className="grid"><thead><tr><th>When</th><th>To</th><th>Template</th><th>Status</th><th>Subject / error</th></tr></thead>
            <tbody>{detail.sends.map((s) => (
              <tr key={s.id}><td>{fmt(s.sent_at ?? s.created_at)}</td><td>{s.email}</td><td>{s.template_id}</td><td><span className={`pill ${s.status}`}>{s.status}</span></td><td>{s.subject}{s.error && <div className="muted">{s.error}</div>}</td></tr>
            ))}</tbody></table>

          <h2>Recent events</h2>
          <table className="grid"><thead><tr><th>When</th><th>Type</th><th>Contact</th></tr></thead>
            <tbody>{detail.events.map((e, i) => (
              <tr key={i}><td>{fmt(e.occurred_at)}</td><td><span className={`pill ${e.type}`}>{e.type}</span></td><td>{e.email}</td></tr>
            ))}</tbody></table>
        </>
      )}
    </main>
  );
}
