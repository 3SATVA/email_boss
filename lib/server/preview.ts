import type { BrandBundle } from "../brands/schema";
import { renderEmail } from "../templates";

/** Render a template with sample data for read-only previews. */
export function samplePreview(bundle: BrandBundle, templateId: string, subjectOverride?: string | null) {
  const tpl = bundle.templates[templateId];
  if (!tpl) return null;
  return renderEmail(
    tpl,
    bundle.partials,
    {
      first_name: "Maya",
      last_name: "Sample",
      email: "maya@example.com",
      custom: { fertility_type: "Kidney Yin Deficiency", starseed_type: "Pleiadian" },
      brand: { name: bundle.config.name, from_name: bundle.config.from_name },
      unsubscribe_url: "https://example.com/unsubscribe?t=preview",
      physical_address: bundle.config.physical_address,
    },
    subjectOverride,
  );
}
