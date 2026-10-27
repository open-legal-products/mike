import type { PythonRunErrorCode, PythonRunEvent } from "@mike/contracts";
import { getSandbox, sandboxLimits, type PythonOutput, type SandboxDoc } from "../../../../lib/sandbox";
import type { Db } from "../../../../lib/supabase";
import type { VisualSourceRef } from "../../../../lib/visuals/source";
import { spotlight } from "../contextBuilders";
import { resolveDocLabel, type DocIndex, type DocStore, type ToolCall } from "../types";
import { buildXlsxWorkbook, loadDocumentForAnalysis, persistGeneratedFile } from "./documentOps";
import { previewOf } from "./visualBuilder";
import { str, type VisualDataSource } from "./visualTools";

export const PYTHON_TOOL_NAME = "run_python";

const RUNS_PER_ANSWER = 25;
const RUNS_FOR_ALL_SUBAGENTS = 50;
const MAX_CODE_CHARS = 50_000;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_STORED_RESULT_BYTES = 8 * 1024 * 1024;
/** A result past this reaches the model as a preview of its shape, not as the JSON. */
const MAX_INLINE_RESULT_CHARS = 20_000;
const MAX_EVENT_STDOUT_CHARS = 16_000;
const MAX_TRACEBACK_CHARS = 8_000;

export const CODE_ANALYSIS_SYSTEM_PROMPT = `CODE ANALYSIS:
You can run Python over the conversation's documents with run_python. Use it whenever an answer depends on a total, share, count, average, date difference or comparison across rows, even when the numbers look simple: do not add, divide or count in your head. Spreadsheets are mounted as files (pandas.read_excel(mike.doc("doc-1").path)); other documents are mounted as their text (mike.read_text("doc-2")). Print what you want to see, return structured figures with mike.result(obj), and save a table as a spreadsheet with mike.save(df, "Name.xlsx"). Aggregate to what the answer needs. Never retype a number a run produced: quote it from the run, or pass the run to a visual in data.`;

const TOOL = {
    type: "function",
    function: {
        name: PYTHON_TOOL_NAME,
        description:
            "Run Python over documents in this conversation. Each call is a fresh interpreter with numpy, pandas, openpyxl, python-dateutil and regex; there is no network and nothing can be installed. Documents named in doc_ids are mounted under /mnt/docs: spreadsheets as files, everything else as extracted text. Use mike.doc(id).path, mike.read_text(id), mike.result(obj) for structured results and mike.save(df, name) to save a spreadsheet. Returns stdout and the result; a large result comes back as a preview of its shape and stays available to visuals by run_id.",
        parameters: {
            type: "object",
            properties: {
                description: { type: "string", description: "What the run computes, in a few words, shown to the user." },
                code: { type: "string", description: `The Python code, at most ${MAX_CODE_CHARS.toLocaleString("en-US")} characters.` },
                doc_ids: {
                    type: "array",
                    items: { type: "string" },
                    description: "The doc_ids to mount, at most 10. Only these are readable from the code.",
                },
            },
            required: ["description", "code"],
        },
    },
};

export function pythonToolsFor(enabled: boolean) {
    return enabled ? [TOOL] : [];
}

type Budget = { limit: number; used: number };

export type PythonTurnState = {
    budgets: Budget[];
    /** The pool every subagent of the answer draws from, once one exists. */
    shared?: Budget;
    /** Results a visual may embed, by run_id. */
    results: Map<string, VisualDataSource>;
    stored: { bytes: number };
};

export function createPythonTurnState(): PythonTurnState {
    return { budgets: [{ limit: RUNS_PER_ANSWER, used: 0 }], results: new Map(), stored: { bytes: 0 } };
}

/** Its own per-answer budget plus a share of the pool all the answer's subagents draw from. */
export function createChildPythonTurnState(parent: PythonTurnState): PythonTurnState {
    if (!parent.shared) parent.shared = { limit: RUNS_FOR_ALL_SUBAGENTS, used: 0 };
    return { budgets: [{ limit: RUNS_PER_ANSWER, used: 0 }, parent.shared], shared: parent.shared, results: parent.results, stored: parent.stored };
}

const remaining = (state: PythonTurnState) => Math.min(...state.budgets.map((b) => b.limit - b.used));

export type PythonToolContext = {
    state: PythonTurnState;
    docStore: DocStore;
    docIndex: DocIndex;
    db: Db;
    userId: string;
    projectId?: string | null;
    orgId?: string | null;
    allowSave: boolean;
    nonce?: string;
    signal?: AbortSignal;
    write: (chunk: string) => void;
};

type PythonCreatedFile = {
    filename: string;
    download_url: string;
    document_id: string;
    version_id: string;
    version_number: number;
    storage_path: string;
};

type PythonToolResult = { content: string; event: PythonRunEvent; created: PythonCreatedFile[] };

const ERROR_MESSAGES: Record<PythonRunErrorCode, string> = {
    python_error: "The code raised an error.",
    timeout: "The run took too long. Aggregate or sample the data and try again.",
    memory: "The run used too much memory. Aggregate or sample the data and try again.",
    output_too_large: "The result is too large. Return only what the answer needs.",
    busy: "The sandbox is busy. Try once more in a moment.",
    unavailable: "Code analysis is not available on this server.",
    crashed: "The interpreter stopped unexpectedly.",
    invalid_input: "The request was not valid.",
};

export function pythonRunErrorMessage(code: unknown, error: string): string {
    if (code === "python_error" || code === "invalid_input") return error;
    return typeof code === "string" && Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code as PythonRunErrorCode] : ERROR_MESSAGES.crashed;
}

async function saveOutputs(outputs: PythonOutput[], ctx: PythonToolContext): Promise<PythonCreatedFile[]> {
    const created: PythonCreatedFile[] = [];
    for (const output of outputs.slice(0, sandboxLimits().maxOutputs)) {
        const title = output.name.replace(/\.xlsx$/i, "");
        const columns = output.columns.map((name, i) => name.trim() || `Column ${i + 1}`);
        const buffer = await buildXlsxWorkbook(title, [{ name: "Sheet1", columns, rows: output.rows }]);
        const saved = await persistGeneratedFile({
            title,
            extension: "xlsx",
            buffer,
            userId: ctx.userId,
            db: ctx.db,
            projectId: ctx.projectId ?? null,
            orgId: ctx.orgId ?? null,
        });
        if (!("error" in saved)) created.push(saved);
    }
    return created;
}

function resultFields(result: unknown, json: string, stored: boolean, runId: string): Record<string, unknown> {
    if (!json) return {};
    if (json.length <= MAX_INLINE_RESULT_CHARS) return { result };
    const size = `${Math.ceil(json.length / 1024)} KB`;
    const preview = previewOf(result);
    const previewJson = JSON.stringify(preview);
    return {
        result_preview: previewJson.length > MAX_INLINE_RESULT_CHARS ? `${previewJson.slice(0, MAX_INLINE_RESULT_CHARS)}...` : preview,
        result_note: stored
            ? `The full result (${size}) is stored as run_id ${runId} and can be passed to a visual in data.`
            : `The result (${size}) was not stored: this answer's results are full. Return less.`,
    };
}

export async function runPythonToolCall(call: ToolCall, args: Record<string, unknown>, ctx: PythonToolContext): Promise<PythonToolResult> {
    const description = str(args.description, MAX_DESCRIPTION_CHARS) || "Code run";
    const code = typeof args.code === "string" ? args.code : "";
    const started = Date.now();
    ctx.write(`data: ${JSON.stringify({ type: "python_run_start", run_id: call.id, description, code })}\n\n`);
    const event: PythonRunEvent = {
        type: "python_run",
        run_id: call.id,
        description,
        code,
        status: "failed",
        stdout: "",
        documents: [],
        files: [],
        duration_ms: 0,
    };
    const fail = (code: PythonRunErrorCode, error = ERROR_MESSAGES[code], extra: Record<string, unknown> = {}): PythonToolResult => {
        event.error = error;
        event.error_code = code;
        event.duration_ms = Date.now() - started;
        const stop = code === "unavailable" ? { instruction: "Do not call run_python again this turn. Say that code analysis is not available and answer without it." } : {};
        return { content: JSON.stringify({ ok: false, error, error_code: code, retryable: code === "busy", ...stop, ...extra }), event, created: [] };
    };
    if (!code.trim()) return fail("invalid_input", "code is required.");
    if (code.length > MAX_CODE_CHARS) return fail("invalid_input", `code must be at most ${MAX_CODE_CHARS.toLocaleString("en-US")} characters.`);
    if (remaining(ctx.state) <= 0) return fail("invalid_input", "The code-run limit for this answer has been reached.");
    for (const b of ctx.state.budgets) b.used++;
    const rawIds = Array.isArray(args.doc_ids) ? args.doc_ids.filter((id): id is string => typeof id === "string") : [];
    if (rawIds.length > sandboxLimits().maxDocs) return fail("invalid_input", `At most ${sandboxLimits().maxDocs} documents can be mounted.`);
    const docs: SandboxDoc[] = [];
    const sources: VisualSourceRef[] = [];
    const notes: string[] = [];
    const mounted = new Set<string>();
    let budget = sandboxLimits().maxInputBytes;
    for (const rawId of rawIds) {
        const label = resolveDocLabel(rawId, ctx.docStore, ctx.docIndex);
        if (!label) {
            return fail("invalid_input", `Document '${rawId}' is not in this conversation. Available doc_ids: ${[...ctx.docStore.keys()].join(", ") || "none"}.`);
        }
        if (mounted.has(label)) continue;
        mounted.add(label);
        const loaded = await loadDocumentForAnalysis(label, ctx.docStore, ctx.docIndex, ctx.db, { bytesBudget: budget });
        if (!loaded.ok) return fail("invalid_input", `Document '${rawId}' ${loaded.error}.`);
        budget -= loaded.bytes;
        if (loaded.note) notes.push(`${label}: ${loaded.note}`);
        docs.push(loaded.doc);
        sources.push(loaded.ref);
        event.documents.push({ document_id: loaded.ref.document_id || undefined, filename: loaded.ref.filename });
    }
    const outcome = await getSandbox().runPython({ code, docs }, { signal: ctx.signal });
    if (!outcome.ok) {
        if (outcome.code === "python_error") {
            event.stdout = outcome.stdout.slice(0, MAX_EVENT_STDOUT_CHARS);
            return fail("python_error", outcome.traceback.slice(0, MAX_TRACEBACK_CHARS), { stdout: outcome.stdout });
        }
        return fail(outcome.code);
    }
    const created = ctx.allowSave ? await saveOutputs(outcome.outputs, ctx) : [];
    const resultJson = outcome.result === undefined ? "" : JSON.stringify(outcome.result);
    const stored = Boolean(resultJson) && ctx.state.stored.bytes + resultJson.length <= MAX_STORED_RESULT_BYTES;
    if (stored) {
        ctx.state.results.set(call.id, { result: outcome.result, documents: sources });
        ctx.state.stored.bytes += resultJson.length;
    }
    event.status = "completed";
    event.stdout = outcome.stdout.slice(0, MAX_EVENT_STDOUT_CHARS);
    event.files = created.map((file) => ({ document_id: file.document_id, version_id: file.version_id, filename: file.filename }));
    event.duration_ms = Date.now() - started;
    const body = JSON.stringify({
        ok: true,
        run_id: call.id,
        stdout: outcome.stdout,
        stdout_truncated: outcome.stdoutTruncated,
        ...resultFields(outcome.result, resultJson, stored, call.id),
        files_saved: created.map((file) => file.filename),
        ...(outcome.outputs.length && !ctx.allowSave ? { note: "Files are not saved in this conversation; the user cannot write here." } : {}),
        mounted: docs.map((doc) => doc.doc_id),
        ...(notes.length ? { notes } : {}),
        duration_ms: outcome.durationMs,
    });
    return { content: ctx.nonce ? spotlight(body, ctx.nonce) : body, event, created };
}
