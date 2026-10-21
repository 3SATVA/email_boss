import Link from "next/link";
import { notFound } from "next/navigation";
import { getBrandBundle } from "@/lib/brands/registry";
import { requireAdmin } from "@/lib/server/admin";
import { samplePreview } from "@/lib/server/preview";

export const dynamic = "force-dynamic";

/** Read-only preview of a template rendered with sample data. */
export default async function TemplatePreview({ params }: { params: Promise<{ slug: string; id: string }> }) {
  await requireAdmin();
  const { slug, id } = await params;
  const bundle = getBrandBundle(slug);
  const tpl = bundle?.templates[id];
  if (!bundle || !tpl) notFound();
  const rendered = samplePreview(bundle, id)!;
  const usedIn = bundle.sequences.filter((s) => s.steps.some((st) => st.template === id));
  return (
    <main>
      <p><Link href={`/admin/brands/${slug}`}>← {bundle.config.name}</Link></p>
      <h1>{id}</h1>
      <div className="card">
        <div><strong>Subject:</strong> {rendered.subject}</div>
        {tpl.preheader && <div className="muted">Preheader: {tpl.preheader}</div>}
        <div className="muted">From: {bundle.config.from_name} &lt;{bundle.config.from_email}&gt; · Used in: {usedIn.map((s) => s.name).join(", ") || "no sequence"}</div>
      </div>
      <iframe title={id} srcDoc={rendered.html} sandbox="" style={{ width: "100%", height: 900, border: "1px solid #e8dfe6", borderRadius: 8, background: "#fff" }} />
      <h2>Plain-text part</h2>
      <pre className="card" style={{ whiteSpace: "pre-wrap" }}>{rendered.text}</pre>
    </main>
  );
}
