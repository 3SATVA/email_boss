import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pullBrand, readSourceRecord, readSources, type GitHubFetch } from "@/lib/brands/pull";

const SHA = "a".repeat(40);
const fixture = path.resolve("tests/fixtures/brands/alpha");

/** Fake GitHub API serving tests/fixtures/brands/alpha as "owner/repo:email/alpha". */
function fakeGitHub(files: Record<string, string>, calls: string[] = []): GitHubFetch {
  const entries = Object.entries(files).map(([p, content], i) => ({ path: p, type: "blob", sha: `blob${i}`, content }));
  return async (url, init) => {
    calls.push(url);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const u = new URL(url);
    let body: unknown;
    if (u.pathname === "/repos/owner/repo/commits/main") body = { sha: SHA };
    else if (u.pathname === `/repos/owner/repo/git/trees/${SHA}`) body = { truncated: false, tree: [{ path: "email", type: "tree", sha: "t" }, ...entries] };
    else {
      const blob = entries.find((e) => u.pathname === `/repos/owner/repo/git/blobs/${e.sha}`);
      if (!blob) return new Response("nope", { status: 404 });
      body = { encoding: "base64", content: Buffer.from(blob.content).toString("base64") };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function filesOf(dir: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}/${e.name}`);
      else out[`${prefix}${rel}/${e.name}`] = fs.readFileSync(path.join(d, e.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}

describe("brands:pull", () => {
  it("vendors the folder at the resolved commit and records the source", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "eb-pull-"));
    fs.mkdirSync(path.join(dest, "alpha"));
    fs.writeFileSync(path.join(dest, "alpha", "stale.txt"), "old");
    const files = { ...filesOf(fixture, "email/alpha"), "other/ignored.txt": "x" };
    const calls: string[] = [];
    const r = await pullBrand("alpha", { repo: "owner/repo", path: "email/alpha", ref: "main" }, {
      destRoot: dest, token: "tok", fetchImpl: fakeGitHub(files, calls), now: new Date("2026-10-21T20:00:00Z"),
    });
    expect(r.commit).toBe(SHA);
    expect(fs.existsSync(path.join(dest, "alpha", "stale.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(dest, "alpha", "brand.json"), "utf8")).toBe(fs.readFileSync(path.join(fixture, "brand.json"), "utf8"));
    expect(readSourceRecord(path.join(dest, "alpha"))).toMatchObject({ repo: "owner/repo", path: "email/alpha", ref: "main", commit: SHA });
    expect(calls.some((c) => c.includes("ignored"))).toBe(false);
    expect(fs.readdirSync(dest)).toEqual(["alpha"]); // no temp dirs left behind
  });

  it("refuses an invalid brand folder or slug mismatch and keeps the old copy", async () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "eb-pull-"));
    fs.mkdirSync(path.join(dest, "beta"));
    fs.writeFileSync(path.join(dest, "beta", "keep.txt"), "keep");
    const files = filesOf(fixture, "email/alpha"); // slug inside is "alpha"
    await expect(
      pullBrand("beta", { repo: "owner/repo", path: "email/alpha", ref: "main" }, { destRoot: dest, token: "tok", fetchImpl: fakeGitHub(files) }),
    ).rejects.toThrow(/slug/);
    expect(fs.readFileSync(path.join(dest, "beta", "keep.txt"), "utf8")).toBe("keep");

    const broken = { ...files, "email/alpha/partials/footer.html": "<p>no unsubscribe</p>" };
    await expect(
      pullBrand("alpha", { repo: "owner/repo", path: "email/alpha", ref: "main" }, { destRoot: dest, token: "tok", fetchImpl: fakeGitHub(broken) }),
    ).rejects.toThrow(/unsubscribe_url/);
    expect(fs.existsSync(path.join(dest, "alpha"))).toBe(false);
  });

  it("the committed brands.sources.json is valid and matches the vendored folders", () => {
    const s = readSources();
    expect(Object.keys(s.brands).sort()).toEqual(["starseed", "yonisync"]);
    for (const [slug, src] of Object.entries(s.brands)) {
      const rec = readSourceRecord(path.resolve("brands", slug))!;
      expect(rec.repo).toBe(src.repo);
      expect(rec.path).toBe(src.path);
    }
  });
});
