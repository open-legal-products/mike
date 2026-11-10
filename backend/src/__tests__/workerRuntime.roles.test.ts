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
vi.mock("../jobs/maintenance", () => ({ runStaleWorkSweep: vi.fn() }));
vi.mock("../modules/uploads/uploads.service", () => ({
  startUploadProcessingWorkers: mocks.startUploads,
}));
vi.mock("../lib/supabase", () => ({ createServerSupabase: vi.fn() }));
vi.mock("../lib/observability/sentry", () => ({ reportError: vi.fn() }));

import { startAllWorkers, stopAllWorkers } from "../workerRuntime";

beforeEach(() => vi.spyOn(console, "log").mockImplementation(() => {}));
afterEach(async () => {
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
