import { describe, expect, it } from "vitest";
import { lintVisual, stripUnsafe, type VisualLintRule } from "../lint";

const ctx = { citeIds: new Set(["doc-1", "doc-2"]) };
const rules = async (html: string) => (await lintVisual(html, ctx)).issues.map((i) => i.rule);

describe("lintVisual", () => {
  it.each<[VisualLintRule, string]>([
    ["size", `<p>${"x".repeat(301 * 1024)}</p>`],
    ["empty", `<div class="mv-page"></div>`],
    ["reserved", `<p id="mv-snapshot">made up</p>`],
    ["forbidden-element", `<p>a</p><iframe src="#"></iframe>`],
    ["forbidden-element", `<p>a</p><script src="x.js"></script>`],
    ["external-url", `<img src="https://example.invalid/a.png"><p>a</p>`],
    ["external-url", `<style>.a{background:url(https://example.invalid/x.png)}</style><p>a</p>`],
    ["network-js", `<p>a</p><script>fetch("/x")</script>`],
    ["network-js", `<p>a</p><script>location.href = "https://example.invalid"</script>`],
    ["network-js", `<p>a</p><script>location = "https://example.invalid"</script>`],
    ["network-js", `<p>a</p><script>new RTCPeerConnection()</script>`],
    ["raw-color", `<p style="color:#ff0000">a</p>`],
    ["raw-color", `<style>.a{border:1px solid red}</style><p class="a">a</p>`],
    ["raw-color", `<svg><rect fill="#000"/></svg>`],
    ["gradient", `<p style="background:linear-gradient(red,blue)">a</p>`],
    ["raw-font", `<p style="font-family:Georgia">a</p>`],
    ["raw-shadow", `<p style="box-shadow:0 1px 2px var(--mv-line)">a</p>`],
    ["raw-radius", `<p style="border-radius:7px">a</p>`],
    ["token", `<style>:root{--mv-ink:red}</style><p>a</p>`],
    ["token", `<p style="color:var(--mv-ink-loud)">a</p>`],
    ["emoji", `<p>Done ✅</p>`],
    ["unknown-cite", `<p data-cite="doc-9">a</p>`],
  ])("reports %s", async (rule, html) => {
    expect(await rules(html)).toContain(rule);
  });

  it("accepts tokens, var fallbacks and colour mixes of tokens, and suggests the nearest token for a literal", async () => {
    const clean = `<style>.a{color:var(--mv-ink);background:color-mix(in oklab, var(--mv-accent) 20%, transparent);border-radius:var(--mv-radius-md);box-shadow:var(--mv-glass-flat-shadow)}</style>
      <div class="mv-page a" style="padding:var(--mv-space-4, 16px)"><p data-cite="doc-1">Fine &amp; dandy</p><a href="#top">top</a></div>`;
    expect((await lintVisual(clean, ctx)).issues).toEqual([]);
    const literal = (await lintVisual(`<p style="color:#6b7280">a</p>`, ctx)).issues[0];
    expect(literal.fix).toContain("var(--mv-ink-muted)");
  });

  it("blocks only size and empty, and strips what cannot be shown", async () => {
    const report = await lintVisual(`<p>a</p><iframe src="#"></iframe>`, ctx);
    expect(report.issues.map((i) => i.blocking)).toEqual([false]);
    expect((await lintVisual(`<p></p>`, ctx)).issues[0].blocking).toBe(true);
    const stripped = await stripUnsafe(
      `<p data-cite="doc-9" id="mv-snapshot">a</p><img src="https://example.invalid/x.png" alt="x"><iframe src="#"></iframe><a href="#x" data-cite="doc-1">b</a>`,
      ctx,
    );
    expect(stripped).toBe(`<p id="mv-snapshot-x">a</p><img alt="x"><a href="#x" data-cite="doc-1">b</a>`);
  });
});
