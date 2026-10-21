/**
 * Email template format
 * ---------------------
 * A template is an .html file with an optional front-matter header:
 *
 *   ---
 *   subject: Your fertility type is {{custom.fertility_type|ready}}
 *   preheader: A few gentle next steps from Susana
 *   ---
 *   <!doctype html> ... {{first_name|there}} ... {{> footer}}
 *
 * Merge tags   {{first_name}}  {{first_name|friend}} (fallback)  {{custom.any_key}}
 *              {{last_name}} {{email}} {{brand.name}} {{brand.from_name}} {{preheader}}
 *              {{unsubscribe_url}} {{physical_address}} {{current_year}}
 * Partials     {{> footer}}  (brands/<slug>/partials/footer.html)
 *
 * Every value is HTML-escaped. There is no raw/unescaped syntax on purpose.
 * Every template MUST include {{> footer}}, and the footer partial MUST contain
 * {{unsubscribe_url}} and {{physical_address}} (CAN-SPAM + Gmail/Yahoo bulk-sender rules).
 */

export interface RenderVars {
  first_name?: string | null;
  last_name?: string | null;
  email: string;
  custom?: Record<string, unknown>;
  brand: { name: string; from_name: string };
  unsubscribe_url: string;
  physical_address: string;
  preheader?: string;
  current_year?: string;
}

export interface ParsedTemplate {
  meta: Record<string, string>;
  body: string;
}

const KNOWN_TAGS = new Set([
  "first_name",
  "last_name",
  "email",
  "brand.name",
  "brand.from_name",
  "unsubscribe_url",
  "physical_address",
  "preheader",
  "current_year",
]);

const TAG_RE = /\{\{\s*(>\s*)?([a-zA-Z0-9_.-]+)\s*(?:\|([^}]*))?\}\}/g;

export function parseFrontMatter(src: string): ParsedTemplate {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) throw new Error(`front matter line without "key: value": ${line}`);
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: src.slice(m[0].length) };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function expandPartials(src: string, partials: Record<string, string>, depth = 0): string {
  if (depth > 5) throw new Error("partials nested too deeply (max 5)");
  return src.replace(TAG_RE, (whole, isPartial: string | undefined, name: string) => {
    if (!isPartial) return whole;
    const p = partials[name];
    if (p === undefined) throw new Error(`unknown partial {{> ${name}}}`);
    return expandPartials(p, partials, depth + 1);
  });
}

function lookup(vars: RenderVars, name: string): unknown {
  if (name.startsWith("custom.")) return vars.custom?.[name.slice(7)];
  switch (name) {
    case "brand.name":
      return vars.brand.name;
    case "brand.from_name":
      return vars.brand.from_name;
    case "current_year":
      return vars.current_year ?? String(new Date().getUTCFullYear());
    default:
      return (vars as unknown as Record<string, unknown>)[name];
  }
}

/** Replace merge tags. `escape` = html-escape values (true for html, false for subject/text). */
export function mergeTags(src: string, vars: RenderVars, escape: boolean): string {
  return src.replace(TAG_RE, (whole, isPartial: string | undefined, name: string, fallback?: string) => {
    if (isPartial) throw new Error(`partial {{> ${name}}} not allowed here`);
    const raw = lookup(vars, name);
    const value = raw === null || raw === undefined || String(raw).trim() === "" ? (fallback ?? "").trim() : String(raw);
    return escape ? escapeHtml(value) : value;
  });
}

/** Static checks used by the manifest builder. Returns a list of problems (empty = ok). */
export function validateTemplate(
  id: string,
  src: { subject?: string; html: string; text?: string },
  partials: Record<string, string>,
): string[] {
  const problems: string[] = [];
  if (!src.subject?.trim()) problems.push(`${id}: missing "subject:" in front matter`);
  if (!/\{\{\s*>\s*footer\s*\}\}/.test(src.html)) problems.push(`${id}: must include {{> footer}}`);
  let expanded = src.html;
  try {
    expanded = expandPartials(src.html, partials);
  } catch (e) {
    problems.push(`${id}: ${(e as Error).message}`);
  }
  for (const text of [expanded, src.subject ?? "", src.text ?? ""]) {
    for (const m of text.matchAll(TAG_RE)) {
      if (m[1]) continue;
      const name = m[2];
      if (!KNOWN_TAGS.has(name) && !/^custom\.[a-z0-9_]+$/.test(name)) {
        problems.push(`${id}: unknown merge tag {{${name}}}`);
      }
    }
  }
  if (src.text !== undefined) {
    if (!/\{\{\s*unsubscribe_url\s*\}\}/.test(src.text)) problems.push(`${id}.txt: must include {{unsubscribe_url}}`);
    if (!/\{\{\s*physical_address\s*\}\}/.test(src.text)) problems.push(`${id}.txt: must include {{physical_address}}`);
  }
  return problems;
}

export function validateFooter(partials: Record<string, string>): string[] {
  const f = partials.footer;
  if (f === undefined) return ["partials/footer.html is required"];
  const problems: string[] = [];
  if (!/\{\{\s*unsubscribe_url\s*\}\}/.test(f)) problems.push("partials/footer.html must contain {{unsubscribe_url}}");
  if (!/\{\{\s*physical_address\s*\}\}/.test(f)) problems.push("partials/footer.html must contain {{physical_address}}");
  return problems;
}

/** Very small HTML -> text converter for the plain-text MIME part. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/(div|span)>/gi, "")
    .replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_w, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").trim();
      return label && label !== href ? `${label} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_w, n: string) => String.fromCodePoint(Number(n)));
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderEmail(
  tpl: { subject: string; preheader?: string; html: string; text?: string },
  partials: Record<string, string>,
  vars: RenderVars,
  subjectOverride?: string | null,
): RenderedEmail {
  const v: RenderVars = { ...vars, preheader: vars.preheader ?? tpl.preheader ?? "" };
  const subject = mergeTags(subjectOverride || tpl.subject, v, false).replace(/\s+/g, " ").trim();
  const html = mergeTags(expandPartials(tpl.html, partials), v, true);
  const text = tpl.text !== undefined ? mergeTags(tpl.text, v, false) : htmlToText(html);

  // Runtime compliance guard: never send an email that lost its unsubscribe link or address.
  if (!html.includes(escapeHtml(vars.unsubscribe_url))) throw new Error("rendered html is missing the unsubscribe link");
  if (!html.includes(escapeHtml(vars.physical_address))) throw new Error("rendered html is missing the physical address");
  if (!subject) throw new Error("rendered subject is empty");
  return { subject, html, text };
}
