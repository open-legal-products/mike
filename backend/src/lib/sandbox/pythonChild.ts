// Only executed in a short-lived child by lib/sandbox/python.ts: one Pyodide
// interpreter per run, killed by the parent afterwards so nothing carries over.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PYODIDE_PACKAGES_DIR } from "./python";
import type { PythonOutput, PythonRunOutcome, SandboxDoc } from "./types";

type RunMessage = {
    type: "run";
    code: string;
    docs: SandboxDoc[];
    limits: { stdoutChars: number; resultBytes: number; maxOutputs: number };
};

const PYODIDE_DIR = path.dirname(require.resolve("pyodide/package.json"));
const PYPI_WHEELS = ["et_xmlfile-2.0.0-py3-none-any.whl", "openpyxl-3.1.5-py2.py3-none-any.whl"];

const PRELUDE = `
import json, re, sys, types, os
_MANIFEST = json.load(open("/mnt/manifest.json", encoding="utf-8"))
class _Doc(dict):
    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError as e:
            raise AttributeError(name) from e
docs = [_Doc(d) for d in _MANIFEST]
def doc(doc_id):
    for d in docs:
        if d["doc_id"] == doc_id or d["filename"] == doc_id:
            return d
    raise KeyError("no document %r; available: %s" % (doc_id, [d["doc_id"] for d in docs]))
def read_text(doc_id):
    with open(doc(doc_id)["text_path"], encoding="utf-8") as f:
        return f.read()
_result = None
_result_set = False
def result(obj):
    global _result, _result_set
    _result, _result_set = obj, True
    return obj
_saved = []
def save(data, name):
    if len(_saved) >= _MAX_OUTPUTS:
        raise ValueError("at most %d files can be saved per run" % _MAX_OUTPUTS)
    try:
        import pandas as pd
    except ImportError:
        pd = None
    if pd is not None and isinstance(data, pd.DataFrame):
        columns = [str(c) for c in data.columns]
        rows = data.astype(object).where(pd.notna(data), None).values.tolist()
    else:
        rows = [list(r) for r in data]
        columns = [str(c) for c in rows.pop(0)] if rows else []
    name = re.sub(r"\\.(csv|xlsx|xls)$", "", str(name).strip(), flags=re.I) or "Output"
    target = "/mnt/out/%d.json" % len(_saved)
    with open(target, "w", encoding="utf-8") as f:
        f.write(_dump({"name": name + ".xlsx", "columns": columns, "rows": rows}))
    _saved.append(target)
def _default(obj):
    for attr in ("to_dict", "tolist", "item", "isoformat"):
        fn = getattr(obj, attr, None)
        if callable(fn):
            try:
                return fn("records") if attr == "to_dict" and hasattr(obj, "columns") else fn()
            except TypeError:
                return fn()
    if isinstance(obj, (set, frozenset)):
        return list(obj)
    return str(obj)
def _dump(obj):
    plain = json.loads(json.dumps(obj, default=_default), parse_constant=lambda _: None)
    return json.dumps(plain, allow_nan=False)
def _block(name):
    module = types.ModuleType(name)
    def __getattr__(attr):
        raise ImportError(name + " is not available: the sandbox has no network and nothing can be installed")
    module.__getattr__ = __getattr__
    return module
for _name in ("js", "pyodide_js", "micropip", "pyodide.http", "pyodide.code"):
    sys.modules[_name] = _block(_name)
`;

function crash(): never {
    process.send?.({ type: "done", outcome: { ok: false, code: "crashed" } });
    process.exit(0);
}

function trimTraceback(message: string): string {
    const lines = message.split("\n");
    const first = lines.findIndex((line) => line.includes('File "<exec>"'));
    return first < 0 ? message : ["Traceback (most recent call last):", ...lines.slice(first)].join("\n");
}

const safeName = (filename: string) => filename.replace(/[^\w.-]+/g, "_").slice(-120) || "file";

// Emscripten opens Python sockets through Node's `ws` package, not the
// global WebSocket, so the modules themselves are refused. This narrows the
// in-process fallback; the container with no network is the boundary.
const NETWORK_MODULES = new Set(
    ["ws", "net", "dgram", "http", "https", "http2", "tls", "dns", "child_process", "worker_threads"].flatMap((name) => [name, `node:${name}`]),
);

async function main() {
    const noNetwork = () => {
        throw new Error("the sandbox has no network");
    };
    globalThis.fetch = noNetwork as typeof fetch;
    (globalThis as { WebSocket?: unknown }).WebSocket = noNetwork;
    const { Module } = (await import("node:module")) as unknown as {
        Module: { _load: (this: unknown, request: string, ...rest: unknown[]) => unknown };
    };
    const load = Module._load;
    Module._load = function (this: unknown, request: string, ...rest: unknown[]) {
        if (NETWORK_MODULES.has(request)) noNetwork();
        return load.call(this, request, ...rest);
    };
    const getBuiltinModule = process.getBuiltinModule;
    process.getBuiltinModule = ((id: string) => {
        if (NETWORK_MODULES.has(id)) noNetwork();
        return getBuiltinModule(id);
    }) as typeof process.getBuiltinModule;

    const output: string[] = [];
    let outputChars = 0;
    let limits: RunMessage["limits"] = { stdoutChars: 20_000, resultBytes: 2 * 1024 * 1024, maxOutputs: 3 };
    const write = (line: string) => {
        if (outputChars >= limits.stdoutChars) return;
        const room = limits.stdoutChars - outputChars;
        output.push(line.length > room ? line.slice(0, room) : line);
        outputChars += Math.min(line.length, room) + 1;
    };
    const { loadPyodide } = await import("pyodide");
    const pyodide = await loadPyodide({
        indexURL: PYODIDE_DIR,
        packageCacheDir: PYODIDE_PACKAGES_DIR,
        jsglobals: {},
        env: { HOME: "/home/pyodide", LANG: "C.UTF-8" },
        stdout: write,
        stderr: write,
    });
    await pyodide.loadPackage(["numpy", "pandas", "python-dateutil", "regex"], { messageCallback: () => {} });
    for (const wheel of PYPI_WHEELS) {
        const bytes = readFileSync(path.join(PYODIDE_PACKAGES_DIR, wheel));
        await pyodide.unpackArchive(new Uint8Array(bytes).buffer, "whl");
    }
    pyodide.runPython("import numpy, pandas, openpyxl, dateutil, regex");
    pyodide.FS.mkdirTree("/mnt/docs");
    pyodide.FS.mkdirTree("/mnt/out");
    pyodide.FS.writeFile("/mnt/manifest.json", "[]");
    // Emscripten reads process.binding("constants") while loading, so the
    // stubs go in afterwards.
    const blocked = () => {
        throw new Error("not available in the sandbox");
    };
    (process as { binding?: unknown }).binding = blocked;
    (process as { _linkedBinding?: unknown })._linkedBinding = blocked;
    pyodide.loadPackage = blocked as never;
    pyodide.mountNodeFS = blocked as never;
    pyodide.FS.mount = blocked as never;
    pyodide.unregisterJsModule("js");
    pyodide.unregisterJsModule("pyodide_js");
    process.send?.({ type: "ready" });

    // `on`, not `once`: Node drops the IPC reference once no listener is
    // left, and the child would exit before it could answer.
    process.on("message", async (message: RunMessage) => {
        if (message?.type !== "run") crash();
        limits = message.limits;
        const started = Date.now();
        let outcome: PythonRunOutcome;
        try {
            const manifest = message.docs.map((doc) => {
                const dir = `/mnt/docs/${doc.doc_id}`;
                pyodide.FS.mkdirTree(dir);
                const textPath = `${dir}/text.txt`;
                pyodide.FS.writeFile(textPath, doc.text);
                pyodide.FS.chmod(textPath, 0o444);
                let filePath: string | null = null;
                if (doc.bytes) {
                    filePath = `${dir}/${safeName(doc.filename)}`;
                    pyodide.FS.writeFile(filePath, Buffer.from(doc.bytes, "base64"));
                    pyodide.FS.chmod(filePath, 0o444);
                }
                pyodide.FS.chmod(dir, 0o555);
                return { doc_id: doc.doc_id, filename: doc.filename, file_type: doc.file_type, path: filePath, text_path: textPath };
            });
            pyodide.FS.writeFile("/mnt/manifest.json", JSON.stringify(manifest));
            pyodide.FS.chmod("/mnt/manifest.json", 0o444);
            pyodide.FS.chmod("/mnt/docs", 0o555);
            const mike = pyodide.pyimport("types").ModuleType("mike");
            pyodide.pyimport("sys").modules.set("mike", mike);
            mike.__dict__.set("_MAX_OUTPUTS", limits.maxOutputs);
            pyodide.runPython(PRELUDE, { globals: mike.__dict__ });
            const globals = pyodide.globals.get("dict")();
            globals.set("mike", mike);
            await pyodide.runPythonAsync(message.code, { globals });
            const json: string | undefined = mike.__dict__.get("_result_set") ? mike._dump(mike.__dict__.get("_result")) : undefined;
            if (json !== undefined && Buffer.byteLength(json, "utf8") > limits.resultBytes) {
                outcome = { ok: false, code: "output_too_large" };
            } else {
                const outputs: PythonOutput[] = [];
                for (const target of mike.__dict__.get("_saved").toJs() as string[]) {
                    outputs.push(JSON.parse(pyodide.FS.readFile(target, { encoding: "utf8" }) as string));
                }
                outcome = {
                    ok: true,
                    stdout: output.join("\n"),
                    stdoutTruncated: outputChars >= limits.stdoutChars,
                    ...(json !== undefined ? { result: JSON.parse(json) } : {}),
                    outputs,
                    durationMs: Date.now() - started,
                };
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            outcome = { ok: false, code: "python_error", traceback: trimTraceback(message), stdout: output.join("\n") };
        }
        process.send?.({ type: "done", outcome });
    });
}

main().catch(crash);
