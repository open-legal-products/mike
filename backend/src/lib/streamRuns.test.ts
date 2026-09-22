import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
    FINISHED_RUN_RETENTION_MS,
    MAX_RUN_LIFETIME_MS,
    attachStreamRunSse,
    getActiveStreamRun,
    getStreamRun,
    resetStreamRunsForTests,
    startStreamRun,
} from "./streamRuns";

/** An Express response reduced to what SSE streaming touches. */
function fakeResponse() {
    const emitter = new EventEmitter();
    const chunks: string[] = [];
    const res = {
        headers: {} as Record<string, string>,
        writableEnded: false,
        setHeader(name: string, value: string) {
            res.headers[name] = value;
        },
        flushHeaders: vi.fn(),
        write(chunk: string) {
            chunks.push(chunk);
            return true;
        },
        end() {
            res.writableEnded = true;
        },
        on: emitter.on.bind(emitter),
        close() {
            emitter.emit("close");
        },
        chunks,
    };
    return res;
}

const start = (id = "run-1", key = "review:r1") =>
    startStreamRun({ id, key, userId: "u1", meta: { label: id } })!;

afterEach(() => {
    resetStreamRunsForTests();
    vi.useRealTimers();
});

describe("stream runs", () => {
    it("survives the requesting response closing and only stops on stop()", () => {
        const run = start();
        const res = fakeResponse();
        const stream = attachStreamRunSse(res as unknown as Response, run);
        expect(res.headers["Content-Type"]).toBe("text/event-stream");
        expect(res.flushHeaders).toHaveBeenCalled();

        stream.write('data: {"type":"cell_update","status":"done"}\n\n');
        expect(res.chunks).toEqual([
            'id: 1\ndata: {"type":"cell_update","status":"done"}\n\n',
        ]);

        // The refresh: the socket goes away. The generation must not.
        res.close();
        expect(stream.signal.aborted).toBe(false);
        expect(stream.write("data: second\n\n")).toBe(true);
        expect(res.chunks).toHaveLength(1);
        expect(run.seq).toBe(2);
        expect(getActiveStreamRun("review:r1")).toBe(run);
        expect(getStreamRun("run-1")).toBe(run);
        expect(run.meta).toEqual({ label: "run-1" });

        run.stop();
        expect(stream.signal.aborted).toBe(true);
        expect(run.stopped).toBe(true);
        // Stopping twice is a no-op, and a finished run cannot be stopped.
        run.stop();
        run.finish();
        expect(run.finished).toBe(true);
    });

    it("replays buffered frames from a sequence number, then tails, then ends", () => {
        const run = start();
        run.write("data: 1\n\n");
        run.write("data: 2\n\n");
        run.write("data: 3\n\n");

        const late = fakeResponse();
        attachStreamRunSse(late as unknown as Response, run, 2);
        expect(late.chunks).toEqual(["id: 2\ndata: 2\n\n", "id: 3\ndata: 3\n\n"]);

        run.write("data: 4\n\n");
        expect(late.chunks).toHaveLength(3);
        expect(late.writableEnded).toBe(false);

        run.finish();
        expect(late.writableEnded).toBe(true);
        expect(run.write("data: late\n\n")).toBe(false);
        // Finishing twice is a no-op.
        run.finish();

        // Within the retention window a reconnect still gets the tail and an end.
        const after = fakeResponse();
        attachStreamRunSse(after as unknown as Response, run, 4);
        expect(after.chunks).toEqual(["id: 4\ndata: 4\n\n"]);
        expect(after.writableEnded).toBe(true);
    });

    it("replays a conditional frame only while its predicate holds", () => {
        const run = start();
        // A "generating" spinner is worth announcing live and misleading to
        // replay once the cell has gone terminal — which is exactly what a
        // client reconnecting mid-run would otherwise be told.
        let stillGenerating = true;
        run.write('data: {"status":"generating"}\n\n', {
            replay: () => stillGenerating,
        });
        run.write('data: {"status":"done"}\n\n');

        const early = fakeResponse();
        attachStreamRunSse(early as unknown as Response, run, 1);
        expect(early.chunks).toEqual([
            'id: 1\ndata: {"status":"generating"}\n\n',
            'id: 2\ndata: {"status":"done"}\n\n',
        ]);

        stillGenerating = false;
        const late = fakeResponse();
        attachStreamRunSse(late as unknown as Response, run, 1);
        expect(late.chunks).toEqual(['id: 2\ndata: {"status":"done"}\n\n']);

        // Live fan-out is unconditional: everyone attached sees the frame as
        // it is written, predicate or not.
        run.write('data: {"status":"generating"}\n\n', { replay: () => false });
        expect(late.chunks).toHaveLength(2);
    });

    it("refuses a second concurrent run for the same key, and frees the slot on finish", () => {
        const first = start("run-1");
        expect(
            startStreamRun({ id: "run-2", key: "review:r1", userId: "u1" }),
        ).toBeNull();
        const other = start("other", "review:r2");
        expect(other.key).toBe("review:r2");
        expect(other.meta).toEqual({ label: "other" });
        first.finish();
        // The finished run still answers a lookup by key (a late reconnect
        // needs its terminal frames) but no longer blocks a successor.
        expect(getActiveStreamRun("review:r1")).toBe(first);
        const second = start("run-2");
        expect(getActiveStreamRun("review:r1")).toBe(second);
        expect(getActiveStreamRun("review:nothing")).toBeNull();
    });

    it("defaults meta to an empty object when the caller keeps no state", () => {
        const run = startStreamRun({ id: "bare", key: "k", userId: "u1" })!;
        expect(run.meta).toEqual({});
        expect(run.userId).toBe("u1");
        expect(run.startedAt).toBeLessThanOrEqual(Date.now());
    });

    it("forgets a finished run after the retention window and stops a run that outlives its lifetime", () => {
        vi.useFakeTimers();
        const run = start();
        run.finish();
        expect(getStreamRun("run-1")).toBe(run);
        vi.advanceTimersByTime(FINISHED_RUN_RETENTION_MS + 1);
        expect(getStreamRun("run-1")).toBeUndefined();
        expect(getActiveStreamRun("review:r1")).toBeNull();

        const hung = start("run-hung", "review:hung");
        vi.advanceTimersByTime(MAX_RUN_LIFETIME_MS + 1);
        expect(hung.signal.aborted).toBe(true);
    });

    it("drops a subscriber whose response throws and keeps serving the others", () => {
        const run = start();
        const healthy = fakeResponse();
        attachStreamRunSse(healthy as unknown as Response, run);
        const broken = {
            write: () => {
                throw new Error("EPIPE");
            },
            end: vi.fn(),
        };
        run.subscribe(1, broken);
        run.write("data: x\n\n");
        expect(healthy.chunks).toHaveLength(1);
        run.finish();
        expect(broken.end).not.toHaveBeenCalled();
        expect(healthy.writableEnded).toBe(true);
    });

    it("stops writing to a response that has already ended", () => {
        const run = start();
        const res = fakeResponse();
        attachStreamRunSse(res as unknown as Response, run);
        res.writableEnded = true;
        run.write("data: ignored\n\n");
        expect(res.chunks).toEqual([]);
    });
});
