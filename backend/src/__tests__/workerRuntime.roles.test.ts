import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each worker thread starts one role, so a stuck job can never stop uploads.
const mocks = vi.hoisted(() => ({
  startWorkers: vi.fn(),
  stopWorkers: vi.fn(async () => {}),
  startDbJobRunner: vi.fn(),
  stopDbJobRunner: vi.fn(async () => {}),
  startUploads: vi.fn(() => vi.fn()),
}));
vi.mock("../workers", () => ({
  anyWorkerEnabled: () => true,
  startWorkers: mocks.startWorkers,
  stopWorkers: mocks.stopWorkers,
}));
vi.mock("../lib/dbq/runner", () => ({
  startDbJobRunner: mocks.startDbJobRunner,
  stopDbJobRunner: mocks.stopDbJobRunner,
}));
vi.mock("../jobs/registry", () => ({
  DB_JOB_HANDLERS: {},
  DB_JOB_FAILURE_HOOKS: {},
  MCP_TOKEN_REFRESH_WINDOW_MS: 0,
}));
vi.mock("../lib/dbq/enqueue", () => ({ enqueueDbJob: vi.fn() }));
vi.mock("../jobs/maintenance", () => ({
  runStaleWorkSweep: vi.fn(async () => ({ documents: 0, cells: 0 })),
}));
vi.mock("../modules/uploads/uploads.service", () => ({
  startUploadProcessingWorkers: mocks.startUploads,
}));
vi.mock("../lib/supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../lib/observability/sentry", () => ({ reportError: vi.fn() }));

import { startAllWorkers, stopAllWorkers } from "../workerRuntime";
import { createServerSupabase } from "../lib/supabase";
import { reportError } from "../lib/observability/sentry";
import { diagnosticErrorTags } from "../lib/observability/sentryPrivacy";

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(async () => {
  vi.useRealTimers();
  await stopAllWorkers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("worker roles", () => {
  it("starts only upload processing on the uploads thread", () => {
    startAllWorkers(["uploads"]);
    expect(mocks.startUploads).toHaveBeenCalledOnce();
    expect(mocks.startDbJobRunner).not.toHaveBeenCalled();
    expect(mocks.startWorkers).not.toHaveBeenCalled();
  });

  it("starts everything except upload processing on the jobs thread", () => {
    startAllWorkers(["jobs"]);
    expect(mocks.startUploads).not.toHaveBeenCalled();
    expect(mocks.startDbJobRunner).toHaveBeenCalledOnce();
    expect(mocks.startWorkers).toHaveBeenCalledOnce();
  });

  it("starts both roles inline or in a standalone worker process", () => {
    startAllWorkers();
    expect(mocks.startUploads).toHaveBeenCalledOnce();
    expect(mocks.startDbJobRunner).toHaveBeenCalledOnce();
  });
});

describe("mcp-refresh-sweep failures", () => {
  it("reports a database outage once, with the network code it failed on", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // supabase-js answers an unreachable gateway with a plain result error:
    // code '' and the errno only in `details`.
    const outage = {
      message: "TypeError: fetch failed",
      details: "TypeError: fetch failed\n\nCaused by: Error: connect ECONNREFUSED private.host:8000 (ECONNREFUSED)",
      hint: "",
      code: "",
    };
    const query: Record<string, unknown> = {};
    for (const method of ["from", "select", "not", "lt", "gt"]) query[method] = () => query;
    query.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: outage });
    vi.mocked(createServerSupabase).mockReturnValue(query as never);

    startAllWorkers(["jobs"]);
    await vi.advanceTimersByTimeAsync(3 * 5 * 60_000);

    const reports = vi.mocked(reportError).mock.calls.filter(
      ([, context]) => (context as { tags?: { component?: string } })?.tags?.component === "mcp-refresh-sweep",
    );
    expect(reports).toHaveLength(1);
    expect(diagnosticErrorTags(reports[0]![0])).toEqual({ failure_code: "ECONNREFUSED" });
  });
});
