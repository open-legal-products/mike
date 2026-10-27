import type { Db } from "../../../../lib/supabase";
import { buildDownloadUrl } from "../../../../lib/downloadTokens";
import { isSpreadsheetDocumentType, isVisualDocumentType } from "../../../../lib/documentTypes";
import { getSandbox } from "../../../../lib/sandbox";
import { resolveVisualCites, type CiteTarget } from "../../../../lib/visuals/cites";
import { composeVisualDocument } from "../../../../lib/visuals/compose";
import { isVisualKind, VISUAL_KINDS, VISUAL_KIT_VERSION, type VisualKind } from "../../../../lib/visuals/kit";
import { FIXES, formatLintIssues, lintVisual, stripUnsafe, type VisualLintIssue } from "../../../../lib/visuals/lint";
import {
    normalizeFragment,
    parseStoredVisual,
    serializeVisual,
    splitDataBlocks,
    type VisualSourceRef,
} from "../../../../lib/visuals/source";
import { saveVisualVersion } from "../../../documents/documents.service";
import { spotlight } from "../contextBuilders";
import { resolveDocLabel, type DocIndex, type DocStore, type ToolCall } from "../types";
import type { KeyedLock } from "./documentLocks";
import {
    clearTurnReadsForDocument,
    loadCurrentVersionBytes,
    persistGeneratedFile,
    safeGeneratedFilename,
    type DocEditedResult,
    type TurnReadState,
} from "./documentOps";
import { scopedDocuments } from "./documentScope";
import { editTask, generateTask, visualBuilderSystemPrompt, type VisualBuilder, type VisualBuildResult } from "./visualBuilder";

export const VISUAL_TOOL_NAMES = { generate: "generate_visual", edit: "edit_visual" } as const;

const MAX_REJECTIONS = 2;
const MAX_BUILDS_PER_ANSWER = 4;
const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 500;
const MAX_BRIEF_CHARS = 8_000;
const DATA_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export const VISUAL_NEXT_ACTION =
    "The visual is shown to the user automatically; do not paste its HTML or a link. Reply in a few sentences: the answer first (the headline figure is fine), then only what the visual cannot show, such as judgement, risk or a next step. Do not walk through the charts or restate their numbers.";

const TYPED_FIGURES =
    "If this visual's figures come from a spreadsheet or need arithmetic, compute them with run_python first (aggregated and shaped as they will be drawn) and pass the run_id in data. If they are stated in the documents as they are, call generate_visual again unchanged.";

export function visualsSystemPrompt(codeAnalysis: boolean): string {
    const figures = codeAnalysis
        ? "Any figure it shows that comes from a spreadsheet or needs arithmetic (totals, shares, counts, date maths, comparisons) is computed with run_python first and passed in data; the brief names the figures by their data name rather than restating them. Return each result shaped as it will be drawn: lists of row objects with short field names, already sorted; percentages as 42, not 0.42; dates as ISO strings; distributions already binned into counts. For a ranking with a long tail, return the top rows and one total for the rest, which goes in a caption: an \"Other\" bar longer than the leaders flattens them. Pass what the pictures need: aggregates, plus a detail list only where the list is itself the point (the entries in breach, the top items); entry-level detail at scale goes to a workbook saved with mike.save, which the visual can mention. Where a row comes from one cell, add cite: {\"cite\": \"doc-1\", \"sheet\": \"Rents\", \"cell\": \"D14\"}."
        : "The builder takes figures straight from the documents and cites them; keep the brief to what the documents state.";
    return `VISUALS:
You can make a visual: an interactive page shown beside the chat and saved as a document the user can reopen, download and export. Make one when a picture answers the question better than prose (see generate_visual's kinds), not for a question prose answers, and never for decoration.
You do not write the page: generate_visual briefs a builder that writes, checks and saves it, then reports back. The builder sees nothing of this conversation, so the brief carries what it needs: the question the visual answers and for whom, the points that matter, the one item to mark, what to leave out, the as-at date, which data block holds which figures, and, for anything quoted from a document rather than computed, its doc_id and page. The builder knows the kit and chooses the form (tabs, charts, columns, colours), so the brief stays at what and why, in a few short paragraphs. The page carries a short title, a one-line subtitle, the pictures and their labels, and at most a line of caption under each. Your findings, reasoning, caveats and advice belong in your reply, not on the page. A visual is a snapshot of the documents at that moment. ${figures}
${VISUAL_NEXT_ACTION} Check the builder's report against the brief. To change a visual, including after the user uploads newer files, call edit_visual with its doc_id and the changes in words.`;
}

const KIND_DESCRIPTION =
    "entity_chart: who owns or controls whom. document_map: how documents relate. defined_terms: terms and their dependencies. timeline: dates and deadlines. concept: a branching rule or process. dashboard: what a dataset shows, in charts. chart: one quantitative comparison. other: anything else.";

const DATA_DESCRIPTION =
    "Results of run_python to put on the page, as { name: run_id }. Each becomes a JSON block the page reads with MikeVisual.data(name). Every figure computed from a spreadsheet or by arithmetic comes in this way, aggregated to what the pictures need.";

const DOCUMENTS_DESCRIPTION =
    "The doc_ids the builder may read and cite. Omit to allow every document in this conversation.";

export function visualTools(opts: { codeAnalysis: boolean }) {
    const data = opts.codeAnalysis
        ? { data: { type: "object", additionalProperties: { type: "string" }, description: DATA_DESCRIPTION } }
        : {};
    const documents = { type: "array", items: { type: "string" }, description: DOCUMENTS_DESCRIPTION };
    return [
        {
            type: "function",
            function: {
                name: VISUAL_TOOL_NAMES.generate,
                description:
                    "Make a visual: brief a builder that writes the page, checks it and saves it as a document shown beside the chat. Returns the saved document and the builder's report.",
                parameters: {
                    type: "object",
                    properties: {
                        kind: { type: "string", enum: [...VISUAL_KINDS], description: KIND_DESCRIPTION },
                        title: {
                            type: "string",
                            description:
                                "The name the visual is saved under: its subject in two to five words, as a lawyer would name the file, such as \"Harrowgate lease portfolio\" or \"Halcyon group structure\". Not the kind of visual and not the finding.",
                        },
                        brief: {
                            type: "string",
                            description:
                                "A few short paragraphs: what the visual answers and for whom, the points that matter, the one item to mark, what to leave out, the as-at date, which data block holds which figures, and the doc_ids and pages for anything quoted. The builder sees only this brief, the data and the documents, and chooses the form itself.",
                        },
                        documents,
                        ...data,
                    },
                    required: ["kind", "title", "brief"],
                },
            },
        },
        {
            type: "function",
            function: {
                name: VISUAL_TOOL_NAMES.edit,
                description:
                    "Change an existing visual: brief the builder with the changes; it edits the current page and saves a new version. Use it for every change, including updating a visual after the user uploads newer files.",
                parameters: {
                    type: "object",
                    properties: {
                        doc_id: { type: "string", description: "The visual's doc_id from the document list." },
                        changes: { type: "string", description: "What to change, in words: the point that is wrong or missing, any new facts, and the data block or doc_ids that hold them. The builder chooses how to show it." },
                        documents,
                        ...data,
                    },
                    required: ["doc_id", "changes"],
                },
            },
        },
    ];
}

export type VisualTurnState = { rejections: Map<string, number>; builds: number; typedFiguresAsked: boolean };

export const createVisualTurnState = (): VisualTurnState => ({ rejections: new Map(), builds: 0, typedFiguresAsked: false });

/** A run_python result the page may embed, with the documents it was computed from. */
export type VisualDataSource = { result: unknown; documents: VisualSourceRef[] };

export type VisualToolContext = {
    state: VisualTurnState;
    docStore: DocStore;
    docIndex: DocIndex;
    db: Db;
    userId: string;
    userEmail?: string | null;
    projectId?: string | null;
    orgId?: string | null;
    /** run_python is offered this turn, so figures can be computed rather than typed. */
    codeAnalysis?: boolean;
    dataSources?: ReadonlyMap<string, VisualDataSource>;
    turnReadState?: TurnReadState;
    documentLocks: KeyedLock;
    nonce?: string;
    /** Runs the builder subagent; without it no visual can be made. */
    build?: VisualBuilder;
    write: (chunk: string) => void;
};

export type VisualToolOutcome =
    | { kind: "generated"; previewFilename: string; result: Record<string, unknown> }
    | { kind: "edited"; content: string; edited?: DocEditedResult };

type DataBlocks = { blocks: Map<string, string>; sources: VisualDataSource[] };

type Prepared =
    | { ok: true; html: string; sources: VisualSourceRef[]; warnings: string[] }
    | { ok: false; result: Record<string, unknown> };

export function str(value: unknown, max = Infinity): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseArguments(call: ToolCall): { args: Record<string, unknown>; truncated: boolean } {
    try {
        return { args: JSON.parse(call.function.arguments || "{}"), truncated: false };
    } catch {
        return { args: {}, truncated: call.function.arguments.trim().length > 0 };
    }
}

function citeResolver(ctx: VisualToolContext, known: Map<string, VisualSourceRef>) {
    return (label: string): CiteTarget | "active" | null => {
        const docLabel = resolveDocLabel(label, ctx.docStore, ctx.docIndex);
        if (docLabel) {
            if (ctx.docStore.get(docLabel)?.inline_text !== undefined) return "active";
            const indexed = ctx.docIndex[docLabel];
            if (indexed) return { document_id: indexed.document_id, version_id: indexed.version_id ?? null };
        }
        const cite = known.get(label);
        return cite ? { document_id: cite.document_id, version_id: cite.version_id } : null;
    };
}

function sourcesFor(ctx: VisualToolContext, targets: CiteTarget[], data: VisualDataSource[], known: Map<string, VisualSourceRef>): VisualSourceRef[] {
    const byId = new Map<string, VisualSourceRef>();
    const filenameOf = (documentId: string) =>
        Object.values(ctx.docIndex).find((d) => d.document_id === documentId)?.filename ?? known.get(documentId)?.filename;
    for (const target of targets) {
        const filename = filenameOf(target.document_id);
        if (filename && !byId.has(target.document_id)) byId.set(target.document_id, { ...target, filename });
    }
    for (const source of data) for (const doc of source.documents) if (!byId.has(doc.document_id)) byId.set(doc.document_id, doc);
    return [...byId.values()];
}

function dataBlocks(args: Record<string, unknown>, ctx: VisualToolContext): DataBlocks | { error: string } {
    const raw = args.data;
    const blocks = new Map<string, string>();
    const sources: VisualDataSource[] = [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { blocks, sources };
    for (const [name, runId] of Object.entries(raw as Record<string, unknown>)) {
        if (!DATA_NAME.test(name)) return { error: `data name "${name}" must be a short lowercase identifier.` };
        const source = typeof runId === "string" ? ctx.dataSources?.get(runId) : undefined;
        if (!source) return { error: `data.${name}: no run_python result with run_id ${String(runId)} in this answer.` };
        // "<" is escaped so the JSON can never close its own script element.
        blocks.set(name, JSON.stringify(source.result ?? null).replace(/</g, "\\u003c"));
        sources.push(source);
    }
    return { blocks, sources };
}

const dataHtml = (blocks: ReadonlyMap<string, string>) =>
    [...blocks].map(([name, json]) => `<script type="application/json" id="mv-data-${name}">${json}</script>`).join("\n");

/** Charts of a spreadsheet's figures are built from a run, not from numbers the model typed into the brief. */
function needsComputedFigures(ctx: VisualToolContext, docStore: DocStore, kind: VisualKind, hasData: boolean): boolean {
    if (!ctx.codeAnalysis || hasData || ctx.state.typedFiguresAsked || (kind !== "dashboard" && kind !== "chart")) return false;
    const spreadsheet = [...docStore.values()].some((doc) => isSpreadsheetDocumentType(doc.file_type) || doc.file_type.toLowerCase() === "csv");
    if (spreadsheet) ctx.state.typedFiguresAsked = true;
    return spreadsheet;
}

function scopeFor(value: unknown, ctx: VisualToolContext): { docStore: DocStore; docIndex: DocIndex; scoped: boolean } | { error: string } {
    if (!Array.isArray(value) || value.length === 0) return { docStore: ctx.docStore, docIndex: ctx.docIndex, scoped: false };
    const requested = value.map(String);
    const labels = requested.map((id) => resolveDocLabel(id, ctx.docStore, ctx.docIndex));
    const unknown = requested.filter((_, i) => !labels[i]);
    if (unknown.length) return { error: `Unknown documents: ${unknown.join(", ")}. Use doc_ids from your document list.` };
    return { ...scopedDocuments(ctx.docStore, ctx.docIndex, [...new Set(labels as string[])]), scoped: true };
}

/** The lint is static; this runs the page once so a script that throws is reported too. */
async function scriptErrors(html: string, kind: VisualKind): Promise<VisualLintIssue[]> {
    const page = composeVisualDocument({ title: "Visual", kind, summary: "", html, kit: VISUAL_KIT_VERSION, createdAt: "", sources: [] });
    const outcome = await getSandbox().render({ html: page, format: "check" });
    if (!outcome.ok) return [];
    return outcome.errors.map((message) => ({
        rule: "script-error",
        blocking: false,
        where: "the page's scripts",
        fix: `${message}. ${FIXES["script-error"]}`,
    }));
}

async function prepare(input: {
    html: unknown;
    data: DataBlocks;
    ctx: VisualToolContext;
    target: string;
    kind: VisualKind;
    knownCites: Map<string, VisualSourceRef>;
}): Promise<Prepared> {
    const { data, ctx, target, kind, knownCites } = input;
    const html = typeof input.html === "string" ? input.html : "";
    if (!html.trim()) {
        return { ok: false, result: { ok: false, saved: false, error: "The html was empty or cut off. Write a smaller page: draw long lists and charts with MikeVisual.table and MikeVisual.chart rather than writing rows out, and use kit classes instead of custom CSS." } };
    }
    const normalized = await normalizeFragment(html);
    const resolver = citeResolver(ctx, knownCites);
    const resolved = resolveVisualCites(normalized.html, resolver);
    const blocks = data.blocks.size ? resolveVisualCites(dataHtml(data.blocks), resolver) : { html: "", targets: [] };
    const withData = (fragment: string) => (blocks.html ? `${blocks.html}\n${fragment}` : fragment);
    const targets = [...resolved.targets, ...blocks.targets];
    const citeIds = new Set(["active", ...targets.map((t) => t.document_id)]);
    const report = await lintVisual(resolved.html, { citeIds });
    const attempts = ctx.state.rejections.get(target) ?? 0;
    const rejects = (issues: VisualLintIssue[]) => issues.length > 0 && (issues.some((issue) => issue.blocking) || attempts < MAX_REJECTIONS);
    if (!rejects(report.issues)) report.issues.push(...(await scriptErrors(withData(resolved.html), kind)));
    if (rejects(report.issues)) {
        const blocking = report.issues.some((issue) => issue.blocking);
        ctx.state.rejections.set(target, attempts + 1);
        const issues = report.issues.map(({ rule, where, fix }) => ({ rule, where, fix }));
        return {
            ok: false,
            result: {
                ok: false,
                saved: false,
                error: `The visual was not saved. Fix these and call again with the complete html:\n${formatLintIssues(report)}`,
                issues,
                attempts_left: blocking ? "until the blocking issues are fixed" : MAX_REJECTIONS - attempts - 1,
                ...(normalized.normalized ? { note: "Send a body fragment, not a whole document; the body was kept." } : {}),
            },
        };
    }
    let body = resolved.html;
    const warnings = [...new Set(report.issues.map((issue: VisualLintIssue) => issue.rule))];
    if (warnings.length > 0) {
        body = await stripUnsafe(body, { citeIds });
        console.warn("[visuals] saved with lint issues", { rules: warnings });
    }
    return {
        ok: true,
        html: withData(body),
        sources: sourcesFor(ctx, targets, data.sources, knownCites),
        warnings,
    };
}

const ALREADY_SAVED = JSON.stringify({ ok: false, error: "The visual is already saved. Reply with your report." });

const savedResult = (warnings: string[]) =>
    JSON.stringify({ ok: true, saved: true, ...(warnings.length ? { warnings } : {}), next_required_action: "Reply with your report." });

function untrusted(text: string, ctx: VisualToolContext): string {
    return ctx.nonce ? spotlight(text, ctx.nonce) : text;
}

function notBuilt(build: VisualBuildResult, ctx: VisualToolContext): string {
    if (build.status === "cancelled") return "The visual build was stopped.";
    const report = build.report ? ` Its report:\n${untrusted(build.report, ctx)}` : "";
    const advice =
        build.limit === "step"
            ? "It ran out of steps before saving. Brief it again with less to read and check, or answer in prose."
            : build.limit
              ? `It reached its ${build.limit} limit before saving. Brief it again for a smaller page with less data (aggregates, and MikeVisual.table for any list), or answer in prose.`
              : "Brief it again more simply, or answer in prose.";
    return `The builder did not save a visual.${report}\n${advice}`;
}

async function runGenerate(call: ToolCall, ctx: VisualToolContext): Promise<VisualToolOutcome> {
    const { args, truncated } = parseArguments(call);
    const kind = isVisualKind(args.kind) ? args.kind : null;
    const title = str(args.title, MAX_TITLE_CHARS);
    const previewFilename = safeGeneratedFilename(title || "Visual", "html");
    const fail = (error: string): VisualToolOutcome => ({ kind: "generated", previewFilename, result: { ok: false, saved: false, error } });
    if (truncated) return fail("The call was cut off before it was complete. Call again with a shorter brief.");
    if (!kind) return fail(`kind must be one of: ${VISUAL_KINDS.join(", ")}.`);
    if (!title) return fail("title is required.");
    const brief = str(args.brief);
    if (!brief) return fail("brief is required: say what the visual answers, what it shows and which documents to cite.");
    if (brief.length > MAX_BRIEF_CHARS) return fail(`The brief is over ${MAX_BRIEF_CHARS.toLocaleString("en-US")} characters. Call again with a shorter one.`);
    if (!ctx.build) return fail("Visuals cannot be built in this conversation.");
    if (ctx.state.builds >= MAX_BUILDS_PER_ANSWER) return fail(`At most ${MAX_BUILDS_PER_ANSWER} visuals can be built in one answer.`);
    const data = dataBlocks(args, ctx);
    if ("error" in data) return fail(data.error);
    const scope = scopeFor(args.documents, ctx);
    if ("error" in scope) return fail(scope.error);
    if (needsComputedFigures(ctx, scope.docStore, kind, data.sources.length > 0)) return fail(TYPED_FIGURES);
    const saveCtx = { ...ctx, docStore: scope.docStore, docIndex: scope.docIndex };
    ctx.state.builds += 1;
    const done: { saved: (Record<string, unknown> & { warnings: string[] }) | null } = { saved: null };
    const build = await ctx.build({
        title,
        task: brief,
        system: visualBuilderSystemPrompt(kind, scope.docStore, ctx.nonce),
        message: generateTask({ title, kind, brief, blocks: data.blocks, nonce: ctx.nonce }),
        docStore: scope.docStore,
        docIndex: scope.docIndex,
        documentsScoped: scope.scoped,
        save: async (input) => {
            if (done.saved) return ALREADY_SAVED;
            const prepared = await prepare({ html: input.html, data, ctx: saveCtx, target: `generate:${title}`, kind, knownCites: new Map() });
            if (!prepared.ok) return JSON.stringify(prepared.result);
            const bytes = serializeVisual({
                title,
                kind,
                summary: str(input.summary, MAX_SUMMARY_CHARS),
                html: prepared.html,
                kit: VISUAL_KIT_VERSION,
                createdAt: new Date().toISOString(),
                sources: prepared.sources,
            });
            const persisted = await persistGeneratedFile({
                title,
                extension: "html",
                buffer: bytes,
                userId: ctx.userId,
                db: ctx.db,
                projectId: ctx.projectId ?? null,
                orgId: ctx.orgId ?? null,
            });
            if ("error" in persisted) return JSON.stringify({ ok: false, saved: false, error: persisted.error });
            done.saved = { ...persisted, warnings: prepared.warnings };
            return savedResult(prepared.warnings);
        },
        saved: () => done.saved !== null,
    });
    if (!done.saved) return fail(notBuilt(build, ctx));
    const { warnings, ...document } = done.saved;
    return {
        kind: "generated",
        previewFilename,
        result: { ...document, kind, report: untrusted(build.report, ctx), ...(warnings.length ? { warnings } : {}) },
    };
}

async function runEdit(call: ToolCall, ctx: VisualToolContext): Promise<VisualToolOutcome> {
    const { args, truncated } = parseArguments(call);
    const rawDocId = typeof args.doc_id === "string" ? args.doc_id : "";
    const docId = resolveDocLabel(rawDocId, ctx.docStore, ctx.docIndex) ?? rawDocId;
    const docInfo = ctx.docStore.get(docId);
    const indexed = ctx.docIndex[docId];
    const fail = (error: string): VisualToolOutcome => ({ kind: "edited", content: JSON.stringify({ ok: false, error }) });
    if (truncated) return fail("The call was cut off before it was complete. Call again with shorter changes.");
    if (!docInfo || !indexed) return fail(`Document '${docId}' not found in this chat's attachments.`);
    if (docInfo.source_kind === "library_template" || docInfo.source_kind === "workflow_asset") {
        return fail("Templates and workflow assets cannot be edited.");
    }
    if (!isVisualDocumentType(docInfo.file_type)) return fail("edit_visual only edits visuals. Use edit_document for Word files.");
    const changes = str(args.changes);
    if (!changes) return fail("changes is required: say what to change, in words.");
    if (changes.length > MAX_BRIEF_CHARS) return fail(`The changes are over ${MAX_BRIEF_CHARS.toLocaleString("en-US")} characters. Call again with shorter ones.`);
    if (!ctx.build) return fail("Visuals cannot be built in this conversation.");
    if (ctx.state.builds >= MAX_BUILDS_PER_ANSWER) return fail(`At most ${MAX_BUILDS_PER_ANSWER} visuals can be built in one answer.`);
    const current = await loadCurrentVersionBytes(indexed.document_id, ctx.db, indexed.version_id);
    if (!current) return fail("The visual could not be read.");
    const stored = await parseStoredVisual(current.bytes);
    const knownCites = new Map(stored.sources.map((s) => [s.document_id, s]));
    const kind = isVisualKind(stored.kind) ? stored.kind : "other";
    const added = dataBlocks(args, ctx);
    if ("error" in added) return fail(added.error);
    const existing = splitDataBlocks(stored.html);
    const data: DataBlocks = { blocks: new Map([...existing.blocks, ...added.blocks]), sources: added.sources };
    const scope = scopeFor(args.documents, ctx);
    if ("error" in scope) return fail(scope.error);
    const saveCtx = { ...ctx, docStore: scope.docStore, docIndex: scope.docIndex };
    // A visual read while editing it is not one of its sources: its own new version would mark it stale.
    const notSelf = (source: VisualSourceRef) => source.document_id !== indexed.document_id;
    // The data blocks that stay on the page keep the documents they were computed from.
    const kept = existing.blocks.size ? stored.sources.filter(notSelf) : [];
    ctx.state.builds += 1;
    const done: { edited: (DocEditedResult & { warnings: string[] }) | null } = { edited: null };
    const build = await ctx.build({
        title: stored.title,
        task: changes,
        system: visualBuilderSystemPrompt(kind, scope.docStore, ctx.nonce),
        message: editTask({ changes, html: existing.html, blocks: data.blocks, nonce: ctx.nonce }),
        docStore: scope.docStore,
        docIndex: scope.docIndex,
        documentsScoped: scope.scoped,
        save: async (input) => {
            if (done.edited) return ALREADY_SAVED;
            const prepared = await prepare({ html: input.html, data, ctx: saveCtx, target: indexed.document_id, kind, knownCites });
            if (!prepared.ok) return JSON.stringify(prepared.result);
            const fresh = prepared.sources.filter(notSelf);
            const sources = [...fresh, ...kept.filter((source) => !fresh.some((f) => f.document_id === source.document_id))];
            const bytes = serializeVisual({
                title: stored.title,
                kind: stored.kind,
                summary: str(input.summary, MAX_SUMMARY_CHARS) || stored.summary,
                html: prepared.html,
                kit: VISUAL_KIT_VERSION,
                createdAt: new Date().toISOString(),
                sources: sources.length ? sources : stored.sources.filter(notSelf),
            });
            ctx.write(`data: ${JSON.stringify({ type: "doc_edited_start", filename: docInfo.filename })}\n\n`);
            const result = await ctx.documentLocks.run(indexed.document_id, () =>
                saveVisualVersion(ctx.db, {
                    documentId: indexed.document_id,
                    userId: ctx.userId,
                    userEmail: ctx.userEmail ?? null,
                    bytes,
                }),
            );
            if (!result.ok) {
                const error = result.kind === "error" ? "The visual could not be saved." : result.detail;
                ctx.write(`data: ${JSON.stringify({ type: "doc_edited", filename: docInfo.filename, document_id: indexed.document_id, version_id: "", download_url: "", annotations: [], error })}\n\n`);
                return JSON.stringify({ ok: false, saved: false, error });
            }
            clearTurnReadsForDocument(ctx.turnReadState, indexed.document_id);
            ctx.docIndex[docId] = { ...indexed, version_id: result.data.version_id, version_number: result.data.version_number };
            ctx.docStore.set(docId, { ...docInfo, search_source: undefined, storage_path: result.data.storage_path });
            const frame: DocEditedResult = {
                filename: docInfo.filename,
                document_id: indexed.document_id,
                version_id: result.data.version_id,
                version_number: result.data.version_number,
                download_url: buildDownloadUrl(result.data.storage_path, result.data.filename),
                annotations: [],
            };
            done.edited = { ...frame, warnings: prepared.warnings };
            ctx.write(`data: ${JSON.stringify({ type: "doc_edited", ...frame })}\n\n`);
            return savedResult(prepared.warnings);
        },
        saved: () => done.edited !== null,
    });
    if (!done.edited) return fail(notBuilt(build, ctx));
    const { warnings, ...edited } = done.edited;
    return {
        kind: "edited",
        edited,
        content: JSON.stringify({
            ok: true,
            doc_id: docId,
            document_id: edited.document_id,
            version_id: edited.version_id,
            version_number: edited.version_number,
            report: untrusted(build.report, ctx),
            ...(warnings.length ? { warnings } : {}),
            next_required_action: VISUAL_NEXT_ACTION,
        }),
    };
}

export function runVisualToolCall(call: ToolCall, ctx: VisualToolContext): Promise<VisualToolOutcome> {
    return call.function.name === VISUAL_TOOL_NAMES.generate ? runGenerate(call, ctx) : runEdit(call, ctx);
}
