/**
 * Citation evaluation: runs real models through `runLLMStream` against the
 * synthetic documents in fixtures.ts and scores the citations each answer
 * ends up with.
 *
 * Both formats run from the same checkout: unset CITATION_FORMAT for the
 * cite_sources tool (the default), or CITATION_FORMAT=inline for inline tags.
 * The runner depends only on `runLLMStream`'s parameters and the SSE frames
 * it writes, and grades citations against the fixture text itself, not by
 * the app's own checker, so both formats are scored the same way.
 *
 *   npx tsx --env-file=<path to backend .env> scripts/citation-eval/run.ts \
 *     --arm cite_sources --models claude-sonnet-5-5,claude-haiku-4-5 --repeats 2 \
 *     --out ../reports/citation-eval/cite_sources.jsonl
 *   CITATION_FORMAT=inline npx tsx ... --arm inline --out .../inline.jsonl
 *
 * Router models (openrouter/...) are treated as saved in the eval user's
 * settings, as the app requires before running them.
 *
 * No database is used: documents are supplied as request-scoped text, as the
 * Word add-in supplies its active document, and `db` is a stub that throws.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { FIXTURES, TASKS, type Task } from "./fixtures";
import { runLLMStream } from "../../src/modules/chat/engine/streaming";
import * as contextBuilders from "../../src/modules/chat/engine/contextBuilders";
import type { DocIndex, DocStore } from "../../src/modules/chat/engine/types";

const { values } = parseArgs({
  options: {
    arm: { type: "string" },
    models: { type: "string", default: "claude-sonnet-5-5" },
    tasks: { type: "string" },
    repeats: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string" },
  },
});
const arm = values.arm;
if (!arm || !values.out) {
  throw new Error("Pass --arm <name> and --out <file.jsonl>.");
}
const models = values.models!.split(",").filter(Boolean);
const taskIds = values.tasks?.split(",").filter(Boolean);
const tasks = TASKS.filter((t) => !taskIds || taskIds.includes(t.id));
const repeats = Number(values.repeats);
const concurrency = Number(values.concurrency);
const outFile = values.out;
// Inline citations with CITATION_FORMAT=inline; otherwise cite_sources.
const citationFormat =
  process.env.CITATION_FORMAT === "inline" ? ("inline" as const) : undefined;
// An arm named for a format must run it: CITATION_FORMAT can also arrive
// from the --env-file, where it is easy to miss.
if ((arm === "inline") !== (citationFormat === "inline")) {
  throw new Error(
    `--arm ${arm} but CITATION_FORMAT is ${process.env.CITATION_FORMAT ?? "unset"}; ` +
      `set CITATION_FORMAT=${arm === "inline" ? "inline" : "cite_sources"} for this arm.`,
  );
}
mkdirSync(dirname(outFile), { recursive: true });

// ---------------------------------------------------------------------------
// Scoring helpers (arm-independent)
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .replace(/\[\[PAGE_BREAK\]\]/g, " ")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function pageText(text: string, page: number): string {
  const start = text.indexOf(`[Page ${page}]`);
  if (start < 0) return "";
  const next = text.indexOf(`[Page ${page + 1}]`, start);
  return text.slice(start, next < 0 ? undefined : next);
}

type CitationQuote = {
  quote?: string;
  page?: number | string;
  sheet?: string;
  cell?: string;
  verification?: { verified?: boolean };
};
type Citation = {
  ref?: number;
  filename?: string;
  doc_id?: string;
  page?: number | string;
  quote?: string;
  quotes?: CitationQuote[];
  verified?: boolean;
};

const fixtureByFilename = new Map(FIXTURES.map((f) => [f.filename, f]));
const fixtureByLabel = new Map(FIXTURES.map((f) => [f.label, f]));

function quotesOf(c: Citation): CitationQuote[] {
  if (Array.isArray(c.quotes) && c.quotes.length) return c.quotes;
  return c.quote ? [{ quote: c.quote, page: c.page }] : [];
}

function pagesOf(page: unknown): number[] {
  if (typeof page === "number") return [page];
  if (typeof page === "string") {
    const m = page.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (m) {
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    }
  }
  return [];
}

/** Grade one quote against the fixture it claims to come from. */
function gradeQuote(
  fixture: { text: string; file_type: string } | undefined,
  q: CitationQuote,
): { inSource: boolean; onClaimedPage: boolean | null } {
  if (!fixture || !q.quote) return { inSource: false, onClaimedPage: null };
  // Table separators are normalised on both sides, so a quote of a whole
  // workbook row matches its row.
  const cells = (text: string) => norm(text.replace(/\s*\|\s*/g, " "));
  const quote = cells(q.quote);
  if (!quote) return { inSource: false, onClaimedPage: null };
  const inSource = cells(fixture.text).includes(quote);
  const pages = pagesOf(q.page);
  if (fixture.file_type !== "pdf" || pages.length === 0) {
    return { inSource, onClaimedPage: null };
  }
  const onClaimedPage = norm(pages.map((p) => pageText(fixture.text, p)).join(" ")).includes(quote);
  return { inSource, onClaimedPage };
}

/** Does any citation point at the expected page or cell? */
function covers(citations: Citation[], expected: Task["expected"][number]): boolean {
  const fixture = fixtureByLabel.get(expected.doc)!;
  return citations.some((c) => {
    if (c.filename !== fixture.filename) return false;
    return quotesOf(c).some((q) => {
      if (expected.page !== undefined) {
        const pages = pagesOf(q.page);
        if (pages.length) return pages.includes(expected.page);
        // Only a quote without a page is placed by its text.
        return !!q.quote && norm(pageText(fixture.text, expected.page)).includes(norm(q.quote));
      }
      if (expected.cell) {
        if (expected.sheet && norm(q.sheet ?? "") !== norm(expected.sheet)) return false;
        const cell = (q.cell ?? "").toUpperCase();
        return cell === expected.cell || cell.split(":").includes(expected.cell);
      }
      return false;
    });
  });
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

type Frame = { t: number; data: Record<string, unknown> };

/**
 * A database with nothing in it: every query builder chain resolves to no
 * rows. Connector, memory and settings lookups then find nothing, as for a
 * new account. Set CITATION_EVAL_DEBUG=1 to see which tables were queried.
 */
// Router models (openrouter/…, vercel/…) run only when the user saved them
// in Settings. The eval user is treated as having saved the ones this run uses.
const savedRouterModels = models
  .map((m) => m.match(/^(openrouter|vercel)\/(.+)$/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => ({ router: m[1], model_id: m[2] }));

function emptyDb(): unknown {
  const empty = { data: null, error: null, count: 0 };
  const makeChain = (table: string | null): unknown => {
    const chain: unknown = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") {
          const result =
            table === "user_router_models"
              ? { data: savedRouterModels.map(({ model_id }) => ({ model_id })), error: null, count: savedRouterModels.length }
              : table === "rpc:find_document_text"
                ? // No library: a document search finds nothing, as on an empty install.
                  { data: { matches: [], next_offset: null, coverage: { total_versions: 0, indexed_versions: 0, pending_versions: 0, failed_versions: 0, versions_needing_ocr: 0 } }, error: null }
                : empty;
          return (resolve: (v: unknown) => void) => resolve(result);
        }
        if (prop === "rpc") {
          return (name: string) => makeChain(`rpc:${name}`);
        }
        if (prop === "from") {
          return (name: string) => {
            if (process.env.CITATION_EVAL_DEBUG) console.error(`[citation-eval] db call: ${name}`);
            return makeChain(name);
          };
        }
        return chain;
      },
      apply(_target, _this, args) {
        if (process.env.CITATION_EVAL_DEBUG && typeof args[0] === "string") {
          console.error(`[citation-eval] db call: ${args[0]}`);
        }
        return chain;
      },
    });
    return chain;
  };
  return makeChain(null);
}

async function runOnce(task: Task, model: string, rep: number) {
  const docStore: DocStore = new Map();
  const docIndex: DocIndex = {};
  for (const f of FIXTURES) {
    docStore.set(f.label, {
      filename: f.filename,
      file_type: f.file_type,
      inline_text: f.text,
    } as never);
    docIndex[f.label] = {
      document_id: fixtureDocumentId(f.label),
      filename: f.filename,
      version_id: null,
      version_number: null,
    };
  }
  const nonce = randomUUID().replace(/-/g, "").slice(0, 16);
  const apiMessages = contextBuilders.buildMessages(
    [
      ...(task.history?.(citationFormat ?? "cite_sources") ?? []),
      { role: "user", content: task.prompt },
    ] as never,
    FIXTURES.map((f) => ({ doc_id: f.label, filename: f.filename })),
    undefined,
    docIndex,
    false,
    nonce,
    "append",
    undefined,
    false,
    ...((citationFormat ? [citationFormat] : []) as []),
  );

  const frames: Frame[] = [];
  const controller = new AbortController();
  let visible = "";
  const started = performance.now();
  // Stage timing: a compact timeline (runs of one frame type), when each
  // marker [N] first appears in the visible text, and when a citation for
  // it first reaches the client (it becomes clickable at the later of the two).
  const timeline: [number, number, string, number][] = [];
  const markerSeenAt = new Map<number, number>();
  const refKnownAt = new Map<number, number>();
  const db = emptyDb();

  let fullText = "";
  let citations: Citation[] | null = null;
  let outcome: "completed" | "stopped" | "failed" = "completed";
  let failure: string | null = null;
  try {
    const result = await runLLMStream({
      ...(citationFormat ? { citationFormat } : {}),
      model,
      apiMessages,
      docStore,
      docIndex,
      userId: "citation-eval",
      db: db as never,
      nonce,
      conversationId: randomUUID(),
      includeResearchTools: false,
      includeMemory: false,
      signal: controller.signal,
      write: (line: string) => {
        if (!line.startsWith("data: ")) return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          return;
        }
        const t = performance.now() - started;
        frames.push({ t, data });
        const type = String(data.type ?? "unknown");
        const last = timeline.at(-1);
        if (last && last[2] === type) {
          last[1] = t;
          last[3] += 1;
        } else {
          timeline.push([t, t, type, 1]);
        }
        if (type === "citations" && Array.isArray(data.citations)) {
          for (const c of data.citations as Citation[]) {
            if (typeof c.ref === "number" && !refKnownAt.has(c.ref)) refKnownAt.set(c.ref, t);
          }
        }
        if (data.type === "content_delta" && typeof data.text === "string") {
          visible += data.text;
          for (const m of visible.matchAll(/\[(\d{1,3})\]/g)) {
            const n = Number(m[1]);
            if (!markerSeenAt.has(n)) markerSeenAt.set(n, t);
          }
          if (task.stopAfterChars && visible.length >= task.stopAfterChars) {
            controller.abort();
          }
        }
      },
    } as Parameters<typeof runLLMStream>[0]);
    fullText = (result as { fullText: string }).fullText;
  } catch (error) {
    const e = error as { name?: string; fullText?: string; citations?: unknown[]; message?: string };
    outcome = e?.name === "AbortError" || controller.signal.aborted ? "stopped" : "failed";
    failure = outcome === "failed" ? String(e?.message ?? error) : null;
    fullText = e?.fullText ?? visible;
    // What the route saves for a stopped or failed turn.
    citations = Array.isArray(e?.citations) ? (e.citations as Citation[]) : [];
  }
  const ended = performance.now() - started;

  if (citations === null) {
    const finals = frames.filter(
      (f) => f.data.type === "citations" && f.data.status === "final",
    );
    citations = (finals.at(-1)?.data.citations as Citation[] | undefined) ?? [];
  }

  const firstContent = frames.find((f) => f.data.type === "content_delta");
  const lastContent = frames.findLast((f) => f.data.type === "content_delta");
  // Per marker: how long after it appeared did it become clickable (null if
  // it never did during the stream).
  const finalRefs = new Set(citations.map((c) => c.ref));
  const markerWaits = [...markerSeenAt].map(([n, seen]) => {
    const known = refKnownAt.get(n);
    if (known === undefined) return finalRefs.has(n) ? Math.round(ended - seen) : null;
    return Math.round(Math.max(0, known - seen));
  });
  const details = frames.find((f) => f.data.type === "response_details")?.data as
    | { usage?: Record<string, number> }
    | undefined;
  const toolErrors = frames.filter(
    (f) => typeof f.data.type === "string" && /error/i.test(f.data.type as string),
  ).length;
  const citeCalls = frames.filter((f) => f.data.type === "citations_recorded").length;

  // Markers the reader sees, and what they resolve to.
  const markers = new Set(
    [...visible.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])),
  );
  const refs = new Set(citations.map((c) => c.ref).filter((r): r is number => typeof r === "number"));
  const dangling = [...markers].filter((m) => !refs.has(m));
  const unused = [...refs].filter((r) => !markers.has(r));
  const sortedRefs = [...refs].sort((a, b) => a - b);
  const gaps = sortedRefs.some((r, i) => r !== i + 1);

  let quotes = 0;
  let unverifiedByApp = 0;
  let notInSource = 0;
  let wrongPage = 0;
  for (const c of citations) {
    const fixture = fixtureByFilename.get(c.filename ?? "") ??
      fixtureByLabel.get(c.doc_id ?? "");
    for (const q of quotesOf(c)) {
      quotes += 1;
      const verified = q.verification?.verified ?? c.verified;
      if (verified === false) unverifiedByApp += 1;
      const grade = gradeQuote(fixture, q);
      if (!grade.inSource) notInSource += 1;
      if (grade.onClaimedPage === false) wrongPage += 1;
    }
  }
  const expectedCovered = task.expected.filter((e) => covers(citations!, e)).length;

  const record = {
    arm,
    model,
    task: task.id,
    rep,
    outcome,
    failure,
    ms_to_first_content: firstContent ? Math.round(firstContent.t) : null,
    ms_total: Math.round(ended),
    ms_last_content: lastContent ? Math.round(lastContent.t) : null,
    marker_waits_ms: markerWaits,
    timeline: timeline.map(([a, b, type, n]) => [Math.round(a), Math.round(b), type, n]),
    usage: details?.usage ?? null,
    visible_chars: visible.length,
    markers: markers.size,
    citations: citations.length,
    cite_calls: citeCalls,
    dangling_markers: dangling.length,
    unused_citations: unused.length,
    // The bug the PR describes: markers in the answer and nothing behind them.
    markers_without_any_citation: markers.size > 0 && citations.length === 0,
    gaps,
    quotes,
    quotes_unverified_by_app: unverifiedByApp,
    quotes_not_in_source: notInSource,
    quotes_wrong_page: wrongPage,
    expected_sources: task.expected.length,
    expected_sources_cited: expectedCovered,
    transport_leak: /<\/?CITATIONS|\[\[(?:doc|case)-|"doc_id"/.test(visible),
    tool_error_frames: toolErrors,
    full_text_chars: fullText.length,
    visible_text: visible,
    citations_raw: citations,
  };
  appendFileSync(outFile, `${JSON.stringify(record)}\n`);
  return record;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

async function main() {
  const jobs: { task: Task; model: string; rep: number }[] = [];
  for (let rep = 0; rep < repeats; rep++)
    for (const model of models)
      for (const task of tasks) jobs.push({ task, model, rep });

  // A length cap is process-wide (LLM_MAX_OUTPUT_TOKENS), so capped tasks
  // run one at a time after the rest.
  const capped = jobs.filter((j) => j.task.maxOutputTokens);
  const free = jobs.filter((j) => !j.task.maxOutputTokens);

  const report = (r: Awaited<ReturnType<typeof runOnce>>) =>
    console.log(
      [
        r.arm, r.model, r.task, `rep${r.rep}`, r.outcome,
        `first=${r.ms_to_first_content}ms`, `total=${r.ms_total}ms`,
        `markers=${r.markers}`, `cites=${r.citations}`, `dangling=${r.dangling_markers}`,
        `notInSource=${r.quotes_not_in_source}`, `covered=${r.expected_sources_cited}/${r.expected_sources}`,
        r.failure ? `failure=${r.failure.slice(0, 120)}` : "",
      ].join(" "),
    );

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (next < free.length) {
        const job = free[next++];
        report(await runOnce(job.task, job.model, job.rep));
      }
    }),
  );
  for (const job of capped) {
    const previous = process.env.LLM_MAX_OUTPUT_TOKENS;
    process.env.LLM_MAX_OUTPUT_TOKENS = String(job.task.maxOutputTokens);
    try {
      report(await runOnce(job.task, job.model, job.rep));
    } finally {
      if (previous === undefined) delete process.env.LLM_MAX_OUTPUT_TOKENS;
      else process.env.LLM_MAX_OUTPUT_TOKENS = previous;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/** A stable fake document UUID per fixture, so stored citations can name it. */
function fixtureDocumentId(label: string): string {
  const n = label.replace(/\D/g, "").padStart(12, "0");
  return `00000000-0000-4000-8000-${n}`;
}
