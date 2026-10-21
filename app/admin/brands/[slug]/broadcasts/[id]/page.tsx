import Link from "next/link";
import { notFound } from "next/navigation";
import { getBrandBundle } from "@/lib/brands/registry";
import { describeSegment } from "@/lib/engine/broadcasts";
import { requireAdmin } from "@/lib/server/admin";
import { fmt, loadBroadcast } from "@/lib/server/dashboard";
import { samplePreview } from "@/lib/server/preview";

export const dynamic = "force-dynamic";

/** Read-only view of one broadcast: audience, progress, engagement, rendered preview. */
export default async function BroadcastPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  await requireAdmin();
  const { slug, id } = await params;
  const data = await loadBroadcast(slug, id);
  if (!data) notFound();
  const { bc, sends, events } = data;
  const bundle = getBrandBundle(slug);
  const preview = bundle ? samplePreview(bundle, bc.template_id, bc.subject_override) : null;
  const ev = (t: string) => events.find((e) => e.type === t);
  return (
    <main>
      <p><Link href={`/admin/brands/${slug}`}>← {bundle?.config.name ?? slug}</Link></p>
      <h1>{bc.name} <span className={`pill ${bc.status}`}>{bc.status}</span></h1>
      <div className="card">
        <div><strong>Audience:</strong> {describeSegment(bc.segment)}</div>
        <div><strong>Template:</strong> {bc.template_id}{bc.subject_override && <> · subject override: {bc.subject_override}</>}</div>
        <div className="muted">Created {fmt(bc.created_at)} · scheduled {fmt(bc.scheduled_at) || "not scheduled (draft)"}{bc.completed_at && <> · finished {fmt(bc.completed_at)}</>}</div>
        <div style={{ marginTop: 8 }}>
          {sends.map((s) => <span key={s.status} className={`pill ${s.status}`} style={{ marginRight: 6 }}>{s.status}: {s.n}</span>)}
          {!sends.length && <span className="muted">No emails queued yet.</span>}
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          delivered {ev("delivered")?.contacts ?? 0} · opened {ev("open")?.contacts ?? 0} · clicked {ev("click")?.contacts ?? 0} ·
          bounced {ev("bounce")?.contacts ?? 0} · complaints {ev("complaint")?.contacts ?? 0} · unsubscribed {ev("unsubscribe")?.contacts ?? 0}
        </div>
      </div>
      {preview ? (
        <>
          <div className="card"><strong>Subject:</strong> {preview.subject}</div>
          <iframe title="preview" srcDoc={preview.html} sandbox="" style={{ width: "100%", height: 900, border: "1px solid #e8dfe6", borderRadius: 8, background: "#fff" }} />
        </>
      ) : (
        <p className="warn">Template {bc.template_id} is not in the deployed brand folder.</p>
      )}
    </main>
  );
}
