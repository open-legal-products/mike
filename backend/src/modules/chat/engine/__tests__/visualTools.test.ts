import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../../lib/supabase";

const mocks = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  saveVisualVersion: vi.fn(),
  loadCurrentVersionBytes: vi.fn(),
  render: vi.fn(async (_req: { html: string; format: "check" }) => ({ ok: true, errors: [] as string[] })),
}));

vi.mock("../../../../lib/sandbox", () => ({ getSandbox: () => ({ render: mocks.render }) }));
vi.mock("../../../../lib/storage", () => ({
  downloadFile: vi.fn(),
  generatedDocKey: (userId: string, docId: string, filename: string) => `generated/${userId}/${docId}/${filename}`,
  uploadFile: mocks.uploadFile,
  extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));
vi.mock("../../../../lib/downloadTokens", () => ({ buildDownloadUrl: () => "/download/test-token" }));
vi.mock("../../../documents/documents.service", () => ({
  applyTrackedEditsToDocument: vi.fn(),
  createDocumentVersion: vi.fn(async () => ({ data: { id: "version-1", version_number: 1 }, error: null })),
  loadCurrentVersionBytes: mocks.loadCurrentVersionBytes,
  readStoredDocumentText: vi.fn(),
  saveVisualVersion: mocks.saveVisualVersion,
}));

import { parseStoredVisual, serializeVisual } from "../../../../lib/visuals/source";
import { createKeyedLock } from "../tools/documentLocks";
import { runToolCalls } from "../tools/toolDispatcher";
import type { VisualBuilder, VisualBuildRun } from "../tools/visualBuilder";
import { createVisualTurnState, runVisualToolCall, type VisualToolContext } from "../tools/visualTools";

function fakeDb() {
  return {
    from(table: string) {
      const query: Record<string, unknown> = {};
      query.insert = vi.fn(() => query);
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.single = vi.fn(async () => ({ data: { id: table === "documents" ? "doc-uuid" : "version-1" }, error: null }));
      return query;
    },
  } as unknown as Db;
}

const PDF = "6f2a4d8e9b1c4e0a8f3b2c1d5e6f7a8b";
const PDF_VERSION = "1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6";

/** A builder that saves each page it is handed, in order, then reports. */
function builder(pages: string[], report = "Drew the page.") {
  const results: Record<string, unknown>[] = [];
  const runs: VisualBuildRun[] = [];
  const build = vi.fn<VisualBuilder>(async (run) => {
    runs.push(run);
    for (const html of pages) results.push(JSON.parse(await run.save({ html, summary: "s" })));
    return {
      status: "completed",
      report,
      event: { type: "delegation", kind: "visual", delegation_id: "b1", title: run.title, task: run.task, status: "completed", brief: report, events: [], model: "m", effort: "standard" },
    };
  });
  return { build, results, runs };
}

function context(overrides: Partial<VisualToolContext> = {}): VisualToolContext {
  return {
    state: createVisualTurnState(),
    docStore: new Map([["doc-1", { storage_path: "documents/u1/x/source.pdf", file_type: "pdf", filename: "Lease.pdf" }]]),
    docIndex: { "doc-1": { document_id: PDF, filename: "Lease.pdf", version_id: PDF_VERSION, version_number: 1 } },
    db: fakeDb(),
    userId: "u1",
    documentLocks: createKeyedLock(),
    build: builder([]).build,
    write: vi.fn(),
    ...overrides,
  };
}

const call = (name: string, input: unknown) => ({
  id: "call-1",
  function: { name, arguments: typeof input === "string" ? input : JSON.stringify(input) },
});

const page = (inner: string) => `<main class="mv-page"><header class="mv-header"><h1 class="mv-title">Lease</h1></header>${inner}</main>`;

const generate = (extra: Record<string, unknown> = {}) =>
  call("generate_visual", { kind: "timeline", title: "Lease dates", brief: "Show the signing and expiry dates from doc-1, as at 1 October 2026.", ...extra });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generate_visual", () => {
  it("briefs the builder with the guide and the documents, saves the page it writes and returns its report", async () => {
    const { build, runs, results } = builder([
      page(`<p data-cite="doc-1" data-page="3">Signed</p><script>MikeVisual.timeline("#t",{items:[{date:"2026-01-01",title:"x",cite:{cite:"doc-1",page:"4"}}]})</script>`),
    ]);
    const outcome = await runVisualToolCall(generate(), context({ build, nonce: "n" }));

    expect(outcome.kind).toBe("generated");
    if (outcome.kind !== "generated") return;
    expect(outcome.result).toMatchObject({ document_id: "doc-uuid", version_id: "version-1", filename: "Lease dates.html", kind: "timeline" });
    expect(outcome.result.report).toContain("Drew the page.");
    expect(runs[0].system).toContain("## Recipe: timeline");
    expect(runs[0].system).toContain("doc-1");
    expect(runs[0].task).toContain("Show the signing and expiry dates");
    expect(results[0]).toMatchObject({ ok: true, saved: true });
    const [, bytes, contentType] = mocks.uploadFile.mock.calls[0];
    expect(contentType).toBe("application/octet-stream");
    const stored = await parseStoredVisual(Buffer.from(bytes as ArrayBuffer));
    expect(stored.html).toContain(`data-cite="${PDF}" data-cite-version="${PDF_VERSION}"`);
    expect(stored.html).toContain(`cite: "${PDF}", citeVersion: "${PDF_VERSION}"`);
    expect(stored.sources).toEqual([{ document_id: PDF, version_id: PDF_VERSION, filename: "Lease.pdf" }]);
    expect(stored.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects lint issues twice with the fixes, then saves with the unsafe parts stripped", async () => {
    const html = page(`<p data-cite="doc-9">x</p><img src="https://example.invalid/a.png" alt="">`);
    const { build, results } = builder([html, html, html]);

    const outcome = await runVisualToolCall(generate(), context({ build }));

    expect(results[0]).toMatchObject({ ok: false, saved: false, attempts_left: 1 });
    expect(results[0].issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: "unknown-cite" }), expect.objectContaining({ rule: "external-url" })]),
    );
    expect(results[1]).toMatchObject({ attempts_left: 0 });
    expect(results[2]).toMatchObject({ ok: true, warnings: expect.arrayContaining(["external-url", "unknown-cite"]) });
    expect(outcome.kind === "generated" && outcome.result).toMatchObject({ document_id: "doc-uuid", warnings: expect.arrayContaining(["external-url"]) });
    const stored = await parseStoredVisual(Buffer.from(mocks.uploadFile.mock.calls[0][1] as ArrayBuffer));
    expect(stored.html).not.toContain("example.invalid");
    expect(stored.html).not.toContain("data-cite");
  });

  it("returns what the rendered page threw to the builder, and tells the assistant when nothing was saved", async () => {
    mocks.render.mockResolvedValueOnce({ ok: true, errors: ["SyntaxError: Identifier 'top' has already been declared"] });
    const { build, results } = builder([page(`<p>x</p><script>const top = 1</script>`)], "The script did not run.");

    const outcome = await runVisualToolCall(generate(), context({ build }));

    expect(results[0]).toMatchObject({ saved: false, attempts_left: 1, error: expect.stringContaining("Identifier 'top' has already been declared") });
    expect(mocks.render.mock.calls[0][0].html).toContain("<!doctype html>");
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(outcome.kind === "generated" && outcome.result).toMatchObject({ saved: false, error: expect.stringContaining("The script did not run.") });
  });

  it("never saves an oversized visual, however often it is retried", async () => {
    const html = page(`<p>${"x".repeat(301 * 1024)}</p>`);
    const { build, results } = builder([html, html, html]);

    await runVisualToolCall(generate(), context({ build }));

    for (const result of results) expect(result).toMatchObject({ saved: false, attempts_left: "until the blocking issues are fixed" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });

  it("puts a run_python result on the page as a data block the builder is told about, and refuses an unknown run_id", async () => {
    const { build, runs } = builder([page(`<div id="c"></div><script>MikeVisual.chart("#c", MikeVisual.data("summary"))</script>`)]);
    const ctx = context({
      build,
      dataSources: new Map([["run-1", { result: { total: 5, note: "</script><b>" }, documents: [{ document_id: "xlsx-id", version_id: "v9", filename: "Sales.xlsx" }] }]]),
    });

    const saved = await runVisualToolCall(generate({ kind: "dashboard", data: { summary: "run-1" } }), ctx);
    expect(saved.kind === "generated" && saved.result).toMatchObject({ document_id: "doc-uuid" });
    expect(runs[0].message).toContain('summary (43 characters):\n{"total":5,"note":"</script><b>"}');
    const stored = await parseStoredVisual(Buffer.from(mocks.uploadFile.mock.calls[0][1] as ArrayBuffer));
    expect(stored.html).toContain(`<script type="application/json" id="mv-data-summary">{"total":5,"note":"\\u003c/script>\\u003cb>"}</script>`);
    expect(stored.sources).toEqual([{ document_id: "xlsx-id", version_id: "v9", filename: "Sales.xlsx" }]);

    const unknown = await runVisualToolCall(generate({ kind: "dashboard", data: { summary: "run-2" } }), ctx);
    expect(unknown.kind === "generated" && unknown.result).toMatchObject({ saved: false, error: expect.stringContaining("run-2") });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("resolves the cites inside a data block to document ids", async () => {
    const { build } = builder([page(`<div id="t"></div><script>MikeVisual.table("#t", { data: MikeVisual.data("fees").rows })</script>`)]);
    const ctx = context({
      build,
      dataSources: new Map([["run-1", { result: { rows: [{ fee: 1, cite: { cite: "doc-1", sheet: "Fees", cell: "D4" } }] }, documents: [] }]]),
    });

    await runVisualToolCall(generate({ kind: "dashboard", data: { fees: "run-1" } }), ctx);

    const stored = await parseStoredVisual(Buffer.from(mocks.uploadFile.mock.calls[0][1] as ArrayBuffer));
    const block = stored.html.match(/id="mv-data-fees">([^<]*)<\/script>/)?.[1] ?? "";
    expect(block).toContain(`"cite": "${PDF}"`);
    expect(block).not.toContain("doc-1");
    expect(stored.sources).toEqual([{ document_id: PDF, version_id: PDF_VERSION, filename: "Lease.pdf" }]);
  });

  it("asks once for run_python figures before building a chart of a spreadsheet without data", async () => {
    const { build } = builder([page(`<div id="c"></div><script>MikeVisual.chart("#c",{type:"bar",data:[{label:"A",value:12}]})</script>`)]);
    const ctx = context({
      build,
      codeAnalysis: true,
      docStore: new Map([["doc-1", { storage_path: "s.xlsx", file_type: "xlsx", filename: "Leases.xlsx" }]]),
      docIndex: { "doc-1": { document_id: PDF, filename: "Leases.xlsx", version_id: PDF_VERSION, version_number: 1 } },
    });
    const attempt = () => runVisualToolCall(generate({ kind: "chart", title: "Rent" }), ctx);

    const first = await attempt();
    expect(first.kind === "generated" && first.result).toMatchObject({ saved: false, error: expect.stringContaining("run_python") });
    expect(build).not.toHaveBeenCalled();
    const second = await attempt();
    expect(second.kind === "generated" && second.result).toMatchObject({ document_id: "doc-uuid" });
  });

  it("builds at most four visuals in one answer", async () => {
    const { build } = builder([page("<p>x</p>")]);
    const ctx = context({ build });

    for (let i = 0; i < 4; i++) await runVisualToolCall(generate(), ctx);
    const fifth = await runVisualToolCall(generate(), ctx);

    expect(fifth.kind === "generated" && fifth.result).toMatchObject({ saved: false, error: expect.stringContaining("At most 4") });
    expect(build).toHaveBeenCalledTimes(4);
  });

  it("sends no doc_created frame when the builder saves nothing", async () => {
    const ctx = context();
    const write = vi.fn();

    const { toolResults } = await runToolCalls([generate()], ctx.docStore, "u1", ctx.db, write, undefined, undefined, ctx.docIndex, undefined, undefined, null, undefined, undefined, undefined, {
      visualBuilder: builder([page(`<p data-cite="doc-9">x</p>`)]).build,
    });

    expect(write.mock.calls.flat().join("")).not.toContain("doc_created");
    expect(JSON.parse((toolResults[0] as { content: string }).content)).toMatchObject({ saved: false });
  });
});

describe("edit_visual", () => {
  const stored = serializeVisual({
    title: "Lease dates",
    kind: "timeline",
    summary: "s",
    html: `<script type="application/json" id="mv-data-x">{"n":1}</script>\n<p data-cite="${PDF}" data-cite-version="${PDF_VERSION}">old</p>`,
    kit: "1",
    createdAt: "2026-10-01T00:00:00.000Z",
    sources: [{ document_id: PDF, version_id: PDF_VERSION, filename: "Lease.pdf" }],
  });
  const edit = (doc_id: string) => call("edit_visual", { doc_id, changes: "Add the signing date." });

  it("refuses non-visuals and templates, and saves the builder's new page as an assistant edit that keeps the data blocks", async () => {
    const { build, runs } = builder([page(`<p data-cite="doc-1" data-page="5">new</p>`)]);
    const ctx = context({
      build,
      nonce: "nonce-7",
      docStore: new Map([
        ["doc-1", { storage_path: "s.pdf", file_type: "pdf", filename: "Lease.pdf" }],
        ["doc-2", { storage_path: "t.html", file_type: "html", filename: "Lease dates.html", source_kind: "library_template" }],
        ["doc-3", { storage_path: "v.html", file_type: "html", filename: "Lease dates.html" }],
      ]),
      docIndex: {
        "doc-1": { document_id: PDF, filename: "Lease.pdf", version_id: PDF_VERSION, version_number: 1 },
        "doc-2": { document_id: "tpl", filename: "Lease dates.html", version_id: "tv", version_number: 1 },
        "doc-3": { document_id: "vis", filename: "Lease dates.html", version_id: "v1", version_number: 1 },
      },
    });

    const notVisual = await runVisualToolCall(edit("doc-1"), ctx);
    expect(notVisual.kind === "edited" && JSON.parse(notVisual.content)).toMatchObject({ ok: false, error: expect.stringContaining("only edits visuals") });
    const template = await runVisualToolCall(edit("doc-2"), ctx);
    expect(template.kind === "edited" && JSON.parse(template.content)).toMatchObject({ ok: false, error: expect.stringContaining("Templates") });
    expect(build).not.toHaveBeenCalled();

    mocks.loadCurrentVersionBytes.mockResolvedValue({ bytes: stored, storage_path: "v.html" });
    mocks.saveVisualVersion.mockResolvedValue({ ok: true, data: { version_id: "v2", version_number: 2, storage_path: "edits/v2.html", filename: "Lease dates.html" } });
    const edited = await runVisualToolCall(edit("doc-3"), ctx);

    expect(runs[0].task).toBe("Add the signing date.");
    expect(runs[0].message).toContain(`<untrusted-content nonce="nonce-7">\n<p data-cite="${PDF}"`);
    expect(runs[0].message).toContain('x (7 characters):\n{"n":1}');
    expect(edited.kind === "edited" && edited.edited).toMatchObject({ document_id: "vis", version_id: "v2", version_number: 2, annotations: [] });
    expect(edited.kind === "edited" && JSON.parse(edited.content)).toMatchObject({ ok: true, doc_id: "doc-3", report: expect.stringContaining("Drew the page.") });
    const saved = mocks.saveVisualVersion.mock.calls[0][1];
    const next = await parseStoredVisual(saved.bytes);
    expect(next.title).toBe("Lease dates");
    expect(next.html).toContain(`id="mv-data-x">{"n":1}</script>`);
    expect(next.html).toContain(`data-cite="${PDF}"`);
    expect(next.createdAt).not.toBe("2026-10-01T00:00:00.000Z");
    expect(ctx.docIndex["doc-3"]).toMatchObject({ version_id: "v2", version_number: 2 });
    expect(ctx.write).toHaveBeenCalledWith(expect.stringContaining('"doc_edited_start"'));
    expect(ctx.write).toHaveBeenCalledWith(expect.stringContaining('"version_id":"v2"'));
  });

  it("keeps a cited source that is not attached to this chat and never lists itself", async () => {
    const { build } = builder([page(`<p data-cite="${PDF}" data-page="5">new</p><p data-cite="doc-3">old figures</p>`)]);
    const ctx = context({
      build,
      docStore: new Map([["doc-3", { storage_path: "v.html", file_type: "html", filename: "Lease dates.html" }]]),
      docIndex: { "doc-3": { document_id: "vis", filename: "Lease dates.html", version_id: "v1", version_number: 1 } },
    });
    mocks.loadCurrentVersionBytes.mockResolvedValue({ bytes: stored, storage_path: "v.html" });
    mocks.saveVisualVersion.mockResolvedValue({ ok: true, data: { version_id: "v2", version_number: 2, storage_path: "edits/v2.html", filename: "Lease dates.html" } });

    await runVisualToolCall(edit("doc-3"), ctx);

    const next = await parseStoredVisual(mocks.saveVisualVersion.mock.calls[0][1].bytes);
    expect(next.sources).toEqual([{ document_id: PDF, version_id: PDF_VERSION, filename: "Lease.pdf" }]);
  });
});
