import fs from "node:fs";
import path from "node:path";
import { loadBrandDir } from "./load";

/**
 * Vendor brand folders from their brand repos into brands/<slug>/ so the Vercel build never
 * needs access to (private) brand repos. The exact source commit is recorded in
 * brands/<slug>/.source.json.
 */

export interface BrandSource {
  repo: string; // owner/name
  path: string; // folder inside the repo
  ref: string; // branch, tag or sha
}

export interface SourcesFile {
  brands: Record<string, BrandSource>;
}

export interface SourceRecord extends BrandSource {
  commit: string;
  pulled_at: string;
  files: number;
}

export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function readSources(file = "brands.sources.json"): SourcesFile {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as SourcesFile;
  for (const [slug, s] of Object.entries(raw.brands ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw new Error(`bad slug ${slug}`);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repo)) throw new Error(`${slug}: bad repo ${s.repo}`);
    if (!s.path || s.path.includes("..")) throw new Error(`${slug}: bad path ${s.path}`);
    if (!s.ref) throw new Error(`${slug}: ref is required`);
  }
  return raw;
}

export function readSourceRecord(brandDir: string): SourceRecord | null {
  const f = path.join(brandDir, ".source.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as SourceRecord) : null;
}

class GitHub {
  constructor(private token: string | undefined, private fetchImpl: GitHubFetch = fetch) {}
  async get<T>(p: string): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${p}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${p}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

export async function resolveCommit(src: BrandSource, token?: string, fetchImpl?: GitHubFetch): Promise<string> {
  const gh = new GitHub(token, fetchImpl);
  const c = await gh.get<{ sha: string }>(`/repos/${src.repo}/commits/${encodeURIComponent(src.ref)}`);
  return c.sha;
}

/** Download the folder at the resolved commit into `destDir` (replacing it). Validates before swapping in. */
export async function pullBrand(
  slug: string,
  src: BrandSource,
  opts: { destRoot: string; token?: string; fetchImpl?: GitHubFetch; now?: Date },
): Promise<SourceRecord> {
  const gh = new GitHub(opts.token, opts.fetchImpl);
  const commit = await resolveCommit(src, opts.token, opts.fetchImpl);
  const tree = await gh.get<{ tree: { path: string; type: string; sha: string; size?: number }[]; truncated: boolean }>(
    `/repos/${src.repo}/git/trees/${commit}?recursive=1`,
  );
  if (tree.truncated) throw new Error(`${src.repo}: tree listing truncated; folder too large`);
  const prefix = src.path.replace(/\/$/, "") + "/";
  const blobs = tree.tree.filter((e) => e.type === "blob" && e.path.startsWith(prefix));
  if (!blobs.length) throw new Error(`${src.repo}@${commit.slice(0, 7)} has no files under ${src.path}`);

  // stage into .tmp-<pid>/<slug> (folder name must equal the slug for validation)
  const stageRoot = path.join(opts.destRoot, `.tmp-pull-${process.pid}`);
  const stage = path.join(stageRoot, slug);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  try {
    for (const b of blobs) {
      const rel = b.path.slice(prefix.length);
      if (rel.split("/").some((p) => p === ".." || p === "" || p.startsWith(".tmp"))) throw new Error(`unsafe path ${b.path}`);
      const blob = await gh.get<{ content: string; encoding: string }>(`/repos/${src.repo}/git/blobs/${b.sha}`);
      const out = path.join(stage, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(blob.content, blob.encoding === "base64" ? "base64" : "utf8"));
    }
    // must be a valid brand (slug matches, templates/sequences valid) before replacing the vendored copy
    const bundle = loadBrandDir(stage);
    if (bundle.config.slug !== slug) throw new Error(`brand.json slug "${bundle.config.slug}" != "${slug}"`);
    const record: SourceRecord = { ...src, commit, pulled_at: (opts.now ?? new Date()).toISOString(), files: blobs.length };
    fs.writeFileSync(path.join(stage, ".source.json"), JSON.stringify(record, null, 2) + "\n");
    const finalDir = path.join(opts.destRoot, slug);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(stage, finalDir);
    return record;
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}
