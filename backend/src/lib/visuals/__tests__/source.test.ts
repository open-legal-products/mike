import { describe, expect, it } from "vitest";
import { normalizeFragment, parseStoredVisual, serializeVisual, splitDataBlocks } from "../source";

describe("stored visuals", () => {
  it("round-trips the fragment and its metadata", async () => {
    const src = {
      title: `Group <structure> & "owners"`,
      kind: "entity_chart",
      summary: "Who owns what",
      html: `<style>.x{color:var(--mv-ink)}</style><div class="mv-page"><p data-cite="abc">Hi &amp; bye</p></div><script>MikeVisual.graph("#g",{})</script>`,
      kit: "1",
      createdAt: "2026-10-20T14:32:00.000Z",
      sources: [{ document_id: "d1", version_id: "v1", filename: "Deed.pdf" }],
    };
    expect(await parseStoredVisual(serializeVisual(src))).toEqual(src);
  });

  it("reduces a whole document to its body and keeps inline head styles and scripts", async () => {
    const { html, normalized } = await normalizeFragment(
      `<!doctype html><html><head><title>t</title><style>.a{}</style><script>MikeVisual.ready()</script></head><body><p>body</p></body></html>`,
    );
    expect(normalized).toBe(true);
    expect(html).toBe("<style>.a{}</style>\n<script>MikeVisual.ready()</script>\n<p>body</p>");
    expect(await normalizeFragment("<p>only</p>")).toEqual({ html: "<p>only</p>", normalized: false });
  });

  it("lifts the data blocks out of a page", () => {
    const { html, blocks } = splitDataBlocks(
      `<script type="application/json" id="mv-data-rents">[1,2]</script>\n<p>page</p>`,
    );
    expect(html).toBe("<p>page</p>");
    expect([...blocks]).toEqual([["rents", "[1,2]"]]);
  });
});
