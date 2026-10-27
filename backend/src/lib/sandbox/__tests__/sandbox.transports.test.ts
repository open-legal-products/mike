import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { startSandboxServer } from "../../../sandbox/server";
import { composeVisualDocument } from "../../visuals/compose";
import { KIT_DIR, readKitAsset } from "../../visuals/kit";
import { sanitizeTextBlock } from "../blocks";
import { selectSandboxClient, socketClient } from "../client";
import { createSandboxCore } from "../core";
import { PYODIDE_PACKAGES_DIR } from "../python";
import type { SandboxClient } from "../types";

const assetsPresent = existsSync(path.join(PYODIDE_PACKAGES_DIR, "manifest.json"));
const RUN = 60_000;

const xlsxBase64 = () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        book,
        XLSX.utils.aoa_to_sheet([["region", "revenue"], ["north", 10], ["south", 20], ["north", 5]]),
        "Sales",
    );
    return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" })).toString("base64");
};

const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const ready = '<script>document.documentElement.dataset.mvReady="1"</script>';

describe.skipIf(!assetsPresent && process.env.REQUIRE_PYODIDE !== "1")("the sandbox", () => {
    const core = createSandboxCore({ limits: { pythonTimeoutMs: 8_000, renderTimeoutMs: 4_000 } });
    const socketPath =
        process.platform === "win32"
            ? `\\\\.\\pipe\\mike-sandbox-test-${process.pid}`
            : path.join(os.tmpdir(), `mike-sandbox-${process.pid}.sock`);
    let server: http.Server;
    let listener: http.Server;
    let hits = 0;
    let listenerPort = 0;
    let listenerUrl = "";

    beforeAll(async () => {
        server = await startSandboxServer(socketPath, core);
        listener = http.createServer((_req, res) => {
            hits++;
            res.end("hit");
        });
        await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
        listenerPort = (listener.address() as { port: number }).port;
        listenerUrl = `http://127.0.0.1:${listenerPort}`;
    });

    afterAll(async () => {
        server.close();
        listener.close();
        await core.shutdown();
    });

    describe.each<[string, () => SandboxClient]>([
        ["in process", () => core],
        ["over the socket", () => socketClient(socketPath)],
    ])("%s", (_, client) => {
        it("reads a mounted spreadsheet with pandas and returns the result as json", async () => {
            const outcome = await client().runPython({
                code: [
                    "import pandas as pd",
                    "df = pd.read_excel(mike.doc('doc-1').path)",
                    "print('rows', len(df))",
                    "mike.result({'by_region': df.groupby('region')['revenue'].sum().to_dict(), 'memo': mike.read_text('doc-2')[:5]})",
                ].join("\n"),
                docs: [
                    { doc_id: "doc-1", filename: "sales.xlsx", file_type: "xlsx", bytes: xlsxBase64(), text: "" },
                    { doc_id: "doc-2", filename: "memo.pdf", file_type: "pdf", text: "Hello memo" },
                ],
            });
            expect(outcome).toMatchObject({
                ok: true,
                stdout: "rows 3",
                result: { by_region: { north: 15, south: 20 }, memo: "Hello" },
            });
        }, RUN);

        it("stops an endless loop at the time limit", async () => {
            await expect(client().runPython({ code: "while True: pass", docs: [] })).resolves.toEqual({ ok: false, code: "timeout" });
        }, RUN);

        it("has no package installer, no fetch, no js, no sockets, no secrets and read-only inputs", async () => {
            process.env.SANDBOX_TEST_CANARY = "secret";
            hits = 0;
            const outcome = await client().runPython({
                code: [
                    "import mike, os",
                    "out = {'canary': os.environ.get('SANDBOX_TEST_CANARY')}",
                    "for name in ['micropip', 'pyodide.http', 'js']:",
                    "    try:",
                    "        m = __import__(name, fromlist=['x'])",
                    "        getattr(m, 'pyfetch', None) or getattr(m, 'install', None) or getattr(m, 'eval')",
                    "        out[name] = 'available'",
                    "    except Exception as e: out[name] = type(e).__name__",
                    "try:",
                    "    open('/mnt/docs/doc-1/text.txt', 'w').write('x'); out['write'] = 'allowed'",
                    "except Exception as e: out['write'] = type(e).__name__",
                    "try:",
                    "    import socket",
                    `    s = socket.create_connection(('127.0.0.1', ${listenerPort}), timeout=2)`,
                    "    s.sendall(b'GET / HTTP/1.0\\r\\n\\r\\n'); out['socket'] = s.recv(100).decode()",
                    "except Exception as e: out['socket'] = type(e).__name__",
                    "mike.result(out)",
                ].join("\n"),
                docs: [{ doc_id: "doc-1", filename: "a.pdf", file_type: "pdf", text: "a" }],
            });
            expect(outcome).toMatchObject({
                ok: true,
                result: {
                    canary: null,
                    micropip: "ImportError",
                    "pyodide.http": "ImportError",
                    js: "ImportError",
                    write: "PermissionError",
                    socket: "OSError",
                },
            });
            expect(hits).toBe(0);
        }, RUN);

        it("cannot reach JavaScript through the FFI", async () => {
            const viaModule = await client().runPython({ code: "import sys\ndel sys.modules['js']\nimport js", docs: [] });
            expect(viaModule).toMatchObject({ ok: false, code: "python_error" });
            const viaProxy = await client().runPython({
                code: "from pyodide.ffi import to_js\nto_js([1]).constructor.constructor('return 1')()",
                docs: [],
            });
            expect(viaProxy).toMatchObject({ ok: false, code: "python_error" });
        }, RUN);

        it("renders a pdf of the page without reaching the network, and recovers from a hung page", async () => {
            hits = 0;
            const html = [
                "<!doctype html><html><body><h1>Marker text</h1>",
                `<img src="${listenerUrl}/i.png"><script>fetch("${listenerUrl}/f").catch(function(){})</script>`,
                `${ready}</body></html>`,
            ].join("");
            const pdf = await client().render({ html, format: "pdf" });
            expect(pdf.ok && pdf.bytes.subarray(0, 4).toString()).toBe("%PDF");
            expect(hits).toBe(0);

            const hung = await client().render({ html: "<!doctype html><html><body><script>while(true){}</script></body></html>", format: "pdf" });
            expect(hung).toEqual({ ok: false, code: "render_timeout" });
            const after = await client().render({ html: "<!doctype html><html><body><p>after</p></body></html>", format: "pdf" });
            expect(after.ok).toBe(true);
        }, RUN);

        it("refuses a pdf of more than 60 pages", async () => {
            const html = `<!doctype html><html><body>${'<p style="break-after:page">p</p>'.repeat(61)}${ready}</body></html>`;
            await expect(client().render({ html, format: "pdf" })).resolves.toEqual({ ok: false, code: "render_failed" });
        }, RUN);

        it("reads a page as heading, paragraph, table, timeline and image blocks in order", async () => {
            const html = [
                `<!doctype html><html><head><script>${readKitAsset(`${KIT_DIR}/mike-visual.js`)}</script></head><body>`,
                '<h1>Rent review</h1><p>Rent rises <button class="mv-cite">1</button> each year.</p>',
                "<p>cap of <del>300%</del><ins>150%</ins>.</p>",
                "<table><thead><tr><th>Year</th><th>Rent</th></tr></thead><tbody><tr><td>2026</td><td>120,000</td></tr></tbody></table>",
                '<div id="tl"></div>',
                '<svg role="img" aria-label="Rent by year" width="200" height="100" style="display:block">',
                '<rect width="200" height="100" fill="blue"/></svg>',
                '<script>MikeVisual.timeline("#tl", { today: "2026-03-10", items: [',
                '{ date: "2026-03-03", title: "Claim issued" }, { date: "2026-03-20", title: "Defence due", kind: "key" }] });',
                "</script>",
                `${ready}</body></html>`,
            ].join("\n");
            const outcome = await client().render({ html, format: "blocks" });
            expect(outcome.ok).toBe(true);
            if (!outcome.ok) return;
            expect(outcome.blocks).toEqual([
                { type: "heading", level: 1, text: "Rent review" },
                { type: "paragraph", text: "Rent rises each year." },
                { type: "paragraph", text: [{ text: "cap of " }, { text: "300%", strike: true }, { text: "150%", underline: true }, { text: "." }] },
                { type: "table", header: true, numeric: [true, true], rows: [["Year", "Rent"], ["2026", "120,000"]] },
                {
                    type: "table",
                    header: true,
                    numeric: [false, false, false],
                    rows: [["Date", "Event", "Status"], ["3 Mar 2026", "Claim issued", ""], ["20 Mar 2026", "Defence due", "Due in 10 days"]],
                },
                { type: "image", png: expect.any(Buffer), widthPx: 200, heightPx: expect.any(Number), alt: "Rent by year" },
            ]);
            const image = outcome.blocks[5];
            expect(image.type === "image" && pngSize(image.png).width).toBe(400);
        }, RUN);

        it("exports every tab under its label", async () => {
            const html = composeVisualDocument(
                {
                    title: "Portfolio",
                    kind: "dashboard",
                    summary: "",
                    kit: "1",
                    createdAt: "2026-10-20T00:00:00.000Z",
                    sources: [],
                    html: [
                        '<div class="mv-tabs">',
                        '<section class="mv-tab" data-tab="Landlords"><p>Three landlords.</p></section>',
                        '<section class="mv-tab" data-tab="Arrears"><p>Two in arrears.</p></section>',
                        "</div>",
                    ].join(""),
                },
                { mode: "export" },
            );
            const outcome = await client().render({ html, format: "blocks" });
            expect(outcome.ok && outcome.blocks).toEqual([
                { type: "heading", level: 2, text: "Landlords" },
                { type: "paragraph", text: "Three landlords." },
                { type: "heading", level: 2, text: "Arrears" },
                { type: "paragraph", text: "Two in arrears." },
                { type: "paragraph", text: "Prepared 20 October 2026 at 00:00 UTC.", style: "small" },
            ]);
        }, RUN);

        it("exports every row of a kit table", async () => {
            const rows = Array.from({ length: 50 }, (_, i) => ({ name: `Entry ${i + 1}`, fee: (i + 1) * 10 }));
            const html = composeVisualDocument(
                {
                    title: "Fees",
                    kind: "dashboard",
                    summary: "",
                    kit: "1",
                    createdAt: "",
                    sources: [],
                    html: `<div id="t"></div><script>MikeVisual.table("#t", { data: ${JSON.stringify(rows)}, columns: [{ key: "name", label: "Entry" }, { key: "fee", label: "Fee", format: "currency" }], pageSize: 10 });</script>`,
                },
                { mode: "export" },
            );
            const outcome = await client().render({ html, format: "blocks" });
            expect(outcome.ok && outcome.blocks).toEqual([
                { type: "table", header: true, numeric: [false, true], rows: [["Entry", "Fee"], ...rows.map((r) => [r.name, `£${r.fee}`])] },
            ]);
        }, RUN);

        it("reports what the page's scripts threw", async () => {
            const html = `<!doctype html><html><body><script>throw new Error("boom")</script>${ready}</body></html>`;
            await expect(client().render({ html, format: "check" })).resolves.toEqual({ ok: true, errors: [expect.stringContaining("boom")] });
        }, RUN);
    });
});

describe("blocks from the page", () => {
    it("strips control characters and clamps the list depth", () => {
        expect(sanitizeTextBlock({ type: "paragraph", text: "a\u0001b", bullet: 12 })).toEqual({ type: "paragraph", text: "ab", bullet: 8 });
    });
});

describe("transport selection", () => {
    it("refuses the in-process sandbox in production unless SANDBOX_ALLOW_LOCAL is set", async () => {
        await expect(selectSandboxClient({ NODE_ENV: "production" }).capabilities()).resolves.toEqual({ python: false, render: false });
    });
});
