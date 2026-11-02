import { afterEach, expect, it, vi } from "vitest";
const probe = vi.hoisted(() => ({ chunks: 0 }));
vi.mock("../../../lib/llm", () => ({
  streamChatWithTools: async ({
    callbacks,
    abortSignal,
  }: {
    callbacks: { onContentDelta: (s: string) => void; onActivity?: () => void };
    abortSignal: AbortSignal;
  }) => {
    callbacks.onContentDelta(
      '{"column_index":0,"summary":"ok","flag":"green","reasoning":"',
    );
    for (let i = 0; i < 31; i++) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Stream aborted.", "AbortError"));
        };
        const timer = setTimeout(() => {
          abortSignal.removeEventListener("abort", abort);
          resolve();
        }, 10000);
        abortSignal.addEventListener("abort", abort, { once: true });
      });
      probe.chunks++;
      callbacks.onActivity?.();
      callbacks.onContentDelta("x");
    }
    callbacks.onContentDelta('"}\n');
    return { fullText: "" };
  },
}));
vi.mock("../tabular.rows", () => ({
  loadRowDocumentText: async () => "healthy document text",
}));
import { streamTabularGenerateSync } from "../tabular.generateStream";
import {
  startStreamRun,
  resetStreamRunsForTests,
} from "../../../lib/streamRuns";

function dbStub() {
  const b: Record<string, unknown> = {};
  for (const method of ["from", "update", "insert", "eq"]) b[method] = () => b;
  b.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: null }).then(resolve);
  return b as never;
}
afterEach(() => {
  resetStreamRunsForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each([
  ["default idle", 300000],
  ["longer idle control", 600000],
])(
  "%s: continuous model output should finish a tabular cell",
  async (_label, idle) => {
    vi.useFakeTimers();
    vi.stubEnv("STREAM_IDLE_TIMEOUT_MS", String(idle));
    probe.chunks = 0;
    const run = startStreamRun({
      id: "tabular-progress",
      key: "review:progress",
      userId: "u",
      forcedStopFrames: [],
    })!;
    const frames: string[] = [];
    const pending = streamTabularGenerateSync({
      write: (line) => {
        frames.push(line);
        return run.write(line);
      },
      db: dbStub(),
      reviewId: "rev",
      columns: [{ index: 0, name: "A", prompt: "a" }],
      rows: [
        {
          id: "row",
          review_id: "rev",
          label: "Contract",
          row_type: "document",
          folder_id: null,
          library_folder_id: null,
          document_id: "doc",
          sort_index: 0,
          source_document_ids: ["doc"],
        },
      ],
      cellMap: new Map(),
      model: "m",
      apiKeys: {},
      generationId: "g",
      abortSignal: run.signal,
      onActivity: run.touch,
    });
    await vi.advanceTimersByTimeAsync(311000);
    const complete = await pending;
    expect(probe.chunks).toBeGreaterThan(20);
    expect(
      complete,
      `chunks=${probe.chunks}, reason=${run.stopReason}, frames=${frames.join(" | ")}`,
    ).toBe(true);
    expect(frames.some((s) => s.includes('"status":"done"'))).toBe(true);
  },
);
