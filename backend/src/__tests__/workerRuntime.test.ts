import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ events: [] as string[], drain: vi.fn(async () => {}), start: vi.fn(), dbDrain: vi.fn(async () => {}) }));
vi.mock("../workers", () => ({ anyWorkerEnabled: () => true, startWorkers: state.start,
    stopWorkerIntake: () => state.events.push("redis-intake"), stopWorkers: () => { state.events.push("redis-drain"); return state.drain(); } }));
vi.mock("../lib/dbq/runner", () => ({ startDbJobRunner: vi.fn(), stopDbJobIntake: () => state.events.push("db-intake"),
    stopDbJobRunner: () => { state.events.push("db-drain"); return state.dbDrain(); } }));
vi.mock("../jobs/registry", () => ({ DB_JOB_HANDLERS: {}, DB_JOB_FAILURE_HOOKS: {}, DB_JOB_EXECUTION_POLICIES: {}, MCP_TOKEN_REFRESH_WINDOW_MS: 1 }));
vi.mock("../jobs/maintenance", () => ({ runStaleWorkSweep: vi.fn() }));
vi.mock("../modules/uploads/uploads.service", () => ({ startUploadProcessingWorkers: () => vi.fn() }));
vi.mock("../lib/runtimeConfig", () => ({ uploadProcessingConfiguration: () => ({ concurrency: 1, maxRunningPerUser: 1 }) }));
import { startAllWorkers, stopAllWorkers } from "../workerRuntime";
afterEach(async () => { await stopAllWorkers(); vi.useRealTimers(); vi.clearAllMocks(); state.events.length = 0; });
describe("worker runtime shutdown", () => {
    it("stops both claim sources before either drain and shares repeated stop", async () => {
        vi.useFakeTimers();
        let release!: () => void;
        state.drain.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
        startAllWorkers();
        const stopping = stopAllWorkers();
        expect(state.events).toEqual(["db-intake", "redis-intake", "redis-drain", "db-drain"]);
        expect(stopAllWorkers()).toBe(stopping);
        startAllWorkers();
        expect(state.start).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        release(); await stopping;
        startAllWorkers();
        expect(state.start).toHaveBeenCalledTimes(2);
    });
    it("does not restart after one drain fails while another remains pending", async () => {
        vi.useFakeTimers();
        let release!: () => void;
        state.drain.mockRejectedValueOnce(new Error("fixture shutdown failure"));
        state.dbDrain.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
        startAllWorkers();
        const stopping = stopAllWorkers();
        const rejected = expect(stopping).rejects.toThrow("fixture shutdown failure");
        await Promise.resolve(); await Promise.resolve();
        startAllWorkers();
        expect(state.start).toHaveBeenCalledTimes(1);
        release(); await rejected;
        startAllWorkers();
        expect(state.start).toHaveBeenCalledTimes(2);
    });

});
