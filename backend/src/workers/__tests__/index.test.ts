import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ stops: [vi.fn(), vi.fn()], queues: [vi.fn(async () => {}), vi.fn(async () => {})], connection: vi.fn(async () => {}), intake: vi.fn() }));
vi.mock("../registry", () => ({ WORKER_REGISTRY: state.stops.map((stop, index) => ({ stop, closeQueue: state.queues[index] })) }));
vi.mock("../appJobsWorker", () => ({ stopAppJobIntake: state.intake }));
vi.mock("../../lib/queue/connection", () => ({ closeRedisConnection: state.connection }));
import { stopWorkers } from "../index";
describe("Redis worker group shutdown", () => {
    it("waits for all drains and closes queues/connection even when a drain fails", async () => {
        let release!: () => void;
        state.stops[0].mockRejectedValueOnce(new Error("fixture failure"));
        state.stops[1].mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
        const stopping = stopWorkers();
        const rejection = expect(stopping).rejects.toThrow("Worker shutdown failed");
        await Promise.resolve(); await Promise.resolve();
        expect(state.intake).toHaveBeenCalledOnce();
        expect(state.queues[0]).not.toHaveBeenCalled();
        expect(state.connection).not.toHaveBeenCalled();
        release(); await rejection;
        expect(state.queues[0]).toHaveBeenCalledOnce();
        expect(state.queues[1]).toHaveBeenCalledOnce();
        expect(state.connection).toHaveBeenCalledOnce();
    });
});
