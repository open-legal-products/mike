import { describe, expect, it } from "vitest";
import { composeVisualDocument, VISUAL_CSP } from "../compose";
import type { VisualSource } from "../source";

const visual = (html: string, extra: Partial<VisualSource> = {}): VisualSource => ({
  title: "Lease map",
  kind: "document_map",
  summary: "",
  html,
  kit: "1",
  createdAt: "2026-10-20T14:32:00.000Z",
  sources: [],
  ...extra,
});

describe("composeVisualDocument", () => {
  it("puts the policy and the WebRTC guard first even when the fragment tries to add its own", () => {
    const doc = composeVisualDocument(
      visual(`</head><meta http-equiv="Content-Security-Policy" content="default-src *"><p>x</p>`),
    );
    const head = doc.slice(doc.indexOf("<head>") + 6, doc.indexOf("</head>"));
    expect(head.trimStart().startsWith(`<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">`)).toBe(true);
    expect(doc.slice(doc.indexOf("<script>"))).toMatch(/^<script>for\(const k of \["RTCPeerConnection"/);
    expect(doc.indexOf("default-src *")).toBeGreaterThan(doc.indexOf("<body>"));
  });

  it("scopes authored scripts so a top-level const top does not collide with window.top", () => {
    const doc = composeVisualDocument(
      visual(`<script>const top = 1;</script><script type="application/json" id="d">{"a":1}</script>`),
    );
    expect(doc).toContain("<script>{\nconst top = 1;\n}</script>");
    expect(doc).toContain(`<script type="application/json" id="d">{"a":1}</script>`);
  });

  it("closes a scoped script at an end tag the browser accepts, not only at </script>", () => {
    const doc = composeVisualDocument(
      visual(`<script>const a = 1;</script ><p>x</p><script>const b = 2;</script\t>`),
    );
    expect(doc).toContain(
      "<script>{\nconst a = 1;\n}</script><p>x</p><script>{\nconst b = 2;\n}</script>",
    );
  });

  it("references nothing outside the document", () => {
    const doc = composeVisualDocument(visual("<p>hello</p>"));
    expect(doc).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)=/i);
    expect(doc).not.toMatch(/(src|href)=["']?https?:|url\(\s*["']?https?:|@import/i);
    expect(doc).toContain("font/woff2;base64,");
  });

  it("inlines elk and echarts only for fragments that call them", () => {
    const plain = composeVisualDocument(visual("<p>text</p>"));
    const graph = composeVisualDocument(visual("<script>MikeVisual.graph('#g', {})</script>"));
    const chart = composeVisualDocument(visual("<script>MikeVisual.chart('#c', {})</script>"));
    expect(plain).not.toContain("org.eclipse.elk");
    expect(plain).not.toContain("window.echarts=");
    expect(graph).toContain("org.eclipse.elk");
    expect(graph).not.toContain("window.echarts=");
    expect(chart).toContain("window.echarts=");
    expect(chart).not.toContain("org.eclipse.elk");
  });

  it("stamps when the visual was prepared and from which files, and export mode marks the page", () => {
    const src = visual("<p>x</p>", {
      sources: [
        { document_id: "a", version_id: "v1", filename: "Lease schedule.xlsx" },
        { document_id: "b", version_id: "v2", filename: "Review memo.pdf" },
      ],
    });
    const view = composeVisualDocument(src);
    expect(view).toContain(
      '<p id="mv-snapshot">Prepared 20 October 2026 at 14:32 UTC from Lease schedule.xlsx and Review memo.pdf.</p>',
    );
    expect(view).toContain('<html lang="en" data-theme="light">');
    expect(composeVisualDocument(src, { mode: "export" })).toContain(
      '<html lang="en" data-theme="light" data-mv-export>',
    );
  });
});
