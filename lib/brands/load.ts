import fs from "node:fs";
import path from "node:path";
import {
  brandConfigSchema,
  sequenceSchema,
  type BrandBundle,
  type Manifest,
  type TemplateDef,
} from "./schema";
import { parseFrontMatter, validateFooter, validateTemplate } from "../templates";

/**
 * Load one brand folder:
 *
 *   <dir>/brand.json
 *   <dir>/partials/footer.html        (required)
 *   <dir>/partials/<name>.html        (optional, used as {{> name}})
 *   <dir>/templates/<id>.html         (front matter: subject, preheader)
 *   <dir>/templates/<id>.txt          (optional plain-text part)
 *   <dir>/sequences/<key>.json
 *
 * Throws with every problem listed if anything is invalid.
 */
export function loadBrandDir(dir: string): BrandBundle {
  const problems: string[] = [];
  const rel = (p: string) => path.relative(process.cwd(), p) || p;

  const brandPath = path.join(dir, "brand.json");
  const parsed = brandConfigSchema.safeParse(JSON.parse(fs.readFileSync(brandPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`${rel(brandPath)}:\n` + parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"));
  }
  const config = parsed.data;
  if (path.basename(dir) !== config.slug) problems.push(`folder name must equal slug "${config.slug}"`);

  const readDir = (sub: string, ext: string) => {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) return [] as string[];
    return fs.readdirSync(d).filter((f) => f.endsWith(ext)).sort();
  };

  const partials: Record<string, string> = {};
  for (const f of readDir("partials", ".html")) {
    partials[path.basename(f, ".html")] = fs.readFileSync(path.join(dir, "partials", f), "utf8");
  }
  problems.push(...validateFooter(partials));

  const templates: Record<string, TemplateDef> = {};
  for (const f of readDir("templates", ".html")) {
    const id = path.basename(f, ".html");
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) {
      problems.push(`templates/${f}: file name must be lowercase a-z 0-9 _ -`);
      continue;
    }
    const { meta, body } = parseFrontMatter(fs.readFileSync(path.join(dir, "templates", f), "utf8"));
    const txtPath = path.join(dir, "templates", `${id}.txt`);
    const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, "utf8") : undefined;
    const tpl: TemplateDef = { id, subject: meta.subject ?? "", preheader: meta.preheader, html: body, text };
    problems.push(...validateTemplate(`templates/${f}`, tpl, partials));
    templates[id] = tpl;
  }

  const sequences = [];
  const keys = new Set<string>();
  for (const f of readDir("sequences", ".json")) {
    const res = sequenceSchema.safeParse(JSON.parse(fs.readFileSync(path.join(dir, "sequences", f), "utf8")));
    if (!res.success) {
      problems.push(...res.error.issues.map((i) => `sequences/${f}: ${i.path.join(".")}: ${i.message}`));
      continue;
    }
    const seq = res.data;
    if (keys.has(seq.key)) problems.push(`sequences/${f}: duplicate sequence key ${seq.key}`);
    keys.add(seq.key);
    for (const st of seq.steps) {
      if (!templates[st.template]) problems.push(`sequences/${f}: step ${st.key} uses unknown template "${st.template}"`);
    }
    sequences.push(seq);
  }

  if (problems.length) {
    throw new Error(`brand ${config.slug} (${rel(dir)}) is invalid:\n` + problems.map((p) => `  - ${p}`).join("\n"));
  }
  return { config, partials, templates, sequences };
}

/** Load every brand folder under `root` (folders starting with "_" or "." are ignored). */
export function loadBrandsRoot(root: string): Manifest {
  const brands: Manifest["brands"] = {};
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const bundle = loadBrandDir(path.join(root, entry.name));
      brands[bundle.config.slug] = bundle;
    }
  }
  return { generated_at: new Date().toISOString(), brands };
}
