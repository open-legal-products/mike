import { afterEach, expect, it, vi } from "vitest";
import type { CodemodeSandboxOptions } from "@earendil-works/pi-codemode" with { "resolution-mode": "import" };

// Control worker exit separately from execution settlement. The real library's
// close() requests termination without awaiting exit; a host read can last longer still.
const state = vi.hoisted(() => ({
  mode: "success" as "success" | "dispatch" | "startup-failure" | "late-start",
  releases: [] as Array<() => void>,
  lateStart: undefined as (() => void) | undefined,
  closed: vi.fn(),
}));
vi.mock("@earendil-works/pi-codemode", () => ({
  loadQuickJSWasm: () => Promise.resolve({}),
  CodemodeSandbox: class {
    constructor(private options: CodemodeSandboxOptions) {
      if (state.mode === "startup-failure") throw new Error("Worker setup failed");
    }
    async execute() {
      await this.options.wasm;
      if (state.mode === "late-start") {
        state.lateStart = () => this.options.acquireWorker?.();
        return { ok: false, error: { kind: "timeout" }, output: [], calls: [] };
      }
      const release = this.options.acquireWorker?.();
      if (release) state.releases.push(release);
      if (state.mode === "dispatch") {
        const controller = new AbortController();
        const tool = this.options.tools!.find((tool) => tool.name === "read_document")!;
        const pending = tool.execute!({ doc_id: "d" }, { signal: controller.signal });
        // Let the runner's serial queue enter the dispatcher before timeout.
        await Promise.resolve();
        controller.abort();
        void Promise.resolve(pending).catch(() => undefined);
        release?.();
        return { ok: false, error: { kind: "timeout" }, output: [], calls: [] };
      }
      return { ok: true, value: 1, output: [], calls: [] };
    }
    async close() { state.closed(); }
  },
}));
vi.mock("../../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/observability/sentry")>()),
  reportError: vi.fn(),
}));

import { runScriptCall, scriptInnerTools, type ScriptToolDispatch } from "./scriptTool";
import { TOOLS } from "./toolSchemas";

const run = (userId = "u1", maxConcurrent = 4, dispatch: ScriptToolDispatch = async () => "{}") =>
  runScriptCall(
    { id: "s1", name: "run_script", input: { code: "return 1;" } },
    { userId, innerTools: scriptInnerTools(TOOLS), dispatch, limits: { maxConcurrent, maxConcurrentPerUser: 1 } },
  ).then(JSON.parse);

afterEach(() => {
  for (const release of state.releases.splice(0)) release();
  state.mode = "success";
  state.closed.mockClear();
});

it("holds process and user reservations after the result until the worker exits", async () => {
  expect(await run()).toMatchObject({ ok: true });
  expect(await run("u2", 1)).toMatchObject({ ok: false, error: expect.stringContaining("Too many scripts") });
  expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining("already have scripts") });
  // Other users can still use the remaining capacity.
  expect(await run("u2")).toMatchObject({ ok: true });
  state.releases[0]();
  expect(await run()).toMatchObject({ ok: true });
});

it("holds both reservations after worker exit until an active host read drains", async () => {
  state.mode = "dispatch";
  let finishRead!: (value: string) => void;
  const dispatch = vi.fn(() => new Promise<string>((resolve) => { finishRead = resolve; }));
  const first = run("u1", 1, dispatch);
  try {
    await vi.waitFor(() => expect(state.closed).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledTimes(1);
    state.mode = "success";
    expect(await run("u2", 1)).toMatchObject({ ok: false, error: expect.stringContaining("Too many scripts") });
    expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining("already have scripts") });
  } finally {
    finishRead?.("{}");
    await first;
  }
  expect(await run("u1", 1)).toMatchObject({ ok: true });
});

it("returns capacity when startup fails before a worker exists", async () => {
  state.mode = "startup-failure";
  expect(await run("u1", 1)).toMatchObject({ ok: false, error: expect.stringContaining("sandbox failed") });
  state.mode = "success";
  expect(await run("u1", 1)).toMatchObject({ ok: true });
});

it("prevents a late worker launch after a startup timeout released its reservation", async () => {
  state.mode = "late-start";
  expect(await run("u1", 1)).toMatchObject({ ok: false });
  expect(() => state.lateStart!()).toThrow("script already ended");
  state.mode = "success";
  expect(await run("u1", 1)).toMatchObject({ ok: true });
});
