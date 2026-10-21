import type { BrandBundle, Manifest } from "./schema";
import manifestJson from "../generated/manifest.json";

/** Brand templates + sequences compiled at build time by scripts/build-manifest.ts. */
export const manifest = manifestJson as unknown as Manifest;

export function getBrandBundle(slug: string, m: Manifest = manifest): BrandBundle | undefined {
  return Object.prototype.hasOwnProperty.call(m.brands, slug) ? m.brands[slug] : undefined;
}
