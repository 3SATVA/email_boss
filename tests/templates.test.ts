import { describe, expect, it } from "vitest";
import { htmlToText, parseFrontMatter, renderEmail, validateFooter, validateTemplate } from "@/lib/templates";
import { loadBrandDir } from "@/lib/brands/load";
import path from "node:path";

const partials = { footer: `<p>{{physical_address}} <a href="{{unsubscribe_url}}">Unsubscribe</a></p>` };
const vars = {
  first_name: "<Maya>",
  email: "maya@example.com",
  custom: { fertility_type: "Kidney Yin" },
  brand: { name: "YoniSync", from_name: "Susana" },
  unsubscribe_url: "https://x.test/unsubscribe?t=a&b",
  physical_address: "1 Main St, LA, CA 90001",
};

describe("templates", () => {
  it("parses front matter", () => {
    const { meta, body } = parseFrontMatter("---\nsubject: Hi {{first_name}}\npreheader: 'pre'\n---\n<p>x</p>");
    expect(meta).toEqual({ subject: "Hi {{first_name}}", preheader: "pre" });
    expect(body).toBe("<p>x</p>");
  });

  it("merges, escapes html, applies fallbacks and partials", () => {
    const r = renderEmail(
      { subject: "Hi {{first_name|friend}} {{custom.missing|there}}", html: "<p>{{first_name}} {{custom.fertility_type}} {{last_name|x}}</p>{{> footer}}" },
      partials,
      vars,
    );
    expect(r.subject).toBe("Hi <Maya> there"); // subjects are plain text, not escaped
    expect(r.html).toContain("&lt;Maya&gt; Kidney Yin x");
    expect(r.html).toContain('href="https://x.test/unsubscribe?t=a&amp;b"');
    expect(r.text).toContain("Unsubscribe (https://x.test/unsubscribe?t=a&b)");
  });

  it("refuses to render without the unsubscribe link", () => {
    expect(() => renderEmail({ subject: "s", html: "<p>no footer</p>" }, partials, vars)).toThrow(/unsubscribe/);
  });

  it("validates required footer, subject and known merge tags", () => {
    expect(validateFooter({})).toHaveLength(1);
    expect(validateFooter({ footer: "<p>{{unsubscribe_url}}</p>" })[0]).toMatch(/physical_address/);
    const problems = validateTemplate("t", { subject: "", html: "<p>{{frist_name}}</p>" }, partials);
    expect(problems.join("\n")).toMatch(/subject/);
    expect(problems.join("\n")).toMatch(/footer/);
    expect(problems.join("\n")).toMatch(/frist_name/);
    expect(validateTemplate("t", { subject: "s", html: "{{custom.ok_field}}{{> footer}}" }, partials)).toEqual([]);
  });

  it("html to text strips hidden preheader and styles", () => {
    const t = htmlToText(`<style>p{}</style><div style="display:none">pre</div><p>Hello&nbsp;there</p><br>bye`);
    expect(t).toBe("Hello there\n\nbye");
  });

  it("the example yonisync brand folder is valid", () => {
    const b = loadBrandDir(path.resolve("brands/yonisync"));
    expect(Object.keys(b.templates).sort()).toEqual(["quiz-day2", "quiz-day5", "quiz-welcome"]);
    expect(b.sequences[0].steps.map((s) => s.delay)).toEqual([0, 2880, 4320]);
  });
});
