import { expect, it, vi } from "vitest";

const html = vi.hoisted(() => ({ value: "" }));
vi.mock("mammoth", () => ({ convertToHtml: async () => ({ value: html.value }) }));
vi.mock("../../convert", () => ({
  docxToPdf: vi.fn(),
  normalizeDocxZipPaths: async (buf: Buffer) => buf,
}));
import { extractDocxMarkdown } from "../documentMarkdown";

const docx = (value: string) => {
  html.value = value;
  return extractDocxMarkdown(new ArrayBuffer(0));
};

it("strips tags exactly as before, including reassembly attempts", async () => {
  expect(await docx("<p>Hello <em>world</em></p>")).toBe("Hello world");
  expect(await docx("<p>x<scr<script>ipt>alert(1)</p>")).toBe("xipt>alert(1)");
  expect(await docx("<p>a <> b &lt;c&gt;</p>")).toBe("a <> b <c>");
});

it("strips a crafted run of unmatched brackets in linear time", async () => {
  // A regex retried from every "<" scans to the end each time: quadratic.
  const source = `<p>${"<".repeat(60_000)}tail</p>`;
  // The old loop takes ~10 s here; a linear scan takes milliseconds, so the
  // bound has two orders of magnitude of slack for a loaded CI runner.
  const started = performance.now();
  const out = await docx(source);
  const elapsed = performance.now() - started;
  expect(out.endsWith("tail")).toBe(true);
  expect(elapsed).toBeLessThan(1_000);
});
