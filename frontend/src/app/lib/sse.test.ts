/**
 * Framing tests for the shared SSE reader. Chunk boundaries never line up
 * with record boundaries, and the last record often arrives without a
 * trailing newline — the two things every hand-rolled copy of this loop got
 * wrong — so both are covered here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSseFrames } from "./sse";

/** A streaming Response emitting exactly the given chunks, then EOF. */
const sseResponse = (chunks: string[]) => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
    return new Response(stream, { status: 200 });
};

const collect = async (chunks: string[], opts?: { signal?: AbortSignal }) => {
    const frames: unknown[] = [];
    for await (const frame of readSseFrames(sseResponse(chunks), opts)) {
        frames.push(frame);
    }
    return frames;
};

afterEach(() => {
    vi.restoreAllMocks();
});

describe("readSseFrames", () => {
    it("reassembles a record split across chunk boundaries", async () => {
        await expect(
            collect(['data: {"type":"a","te', 'xt":"hi"}\n\n']),
        ).resolves.toEqual([{ type: "a", text: "hi" }]);
    });

    it("yields several records arriving in one chunk, in order", async () => {
        await expect(
            collect(['data: {"n":1}\ndata: {"n":2}\ndata: {"n":3}\n\n']),
        ).resolves.toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    it("delivers the final record when the stream ends without a newline", async () => {
        await expect(
            collect(['data: {"n":1}\n\n', 'data: {"n":2}']),
        ).resolves.toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("handles CRLF-delimited streams", async () => {
        await expect(
            collect(['data: {"n":1}\r\n\r\ndata: {"n":2}\r\n\r\n']),
        ).resolves.toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("stops at [DONE] without yielding it", async () => {
        await expect(
            collect(['data: {"n":1}\n\n', "data: [DONE]\n\n", 'data: {"n":2}\n\n']),
        ).resolves.toEqual([{ n: 1 }]);
    });

    it("warns about malformed JSON and keeps consuming", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await expect(
            collect(["data: {not json}\n\n", 'data: {"n":2}\n\n']),
        ).resolves.toEqual([{ n: 2 }]);
        expect(warn).toHaveBeenCalled();
    });

    it("ignores comments, event lines and blank data", async () => {
        await expect(
            collect([": keep-alive\nevent: ping\ndata:\n\n", 'data: {"n":1}\n\n']),
        ).resolves.toEqual([{ n: 1 }]);
    });

    // Cancelling a body that already delivered [DONE] makes Chromium record
    // the completed request as net::ERR_ABORTED — every chat turn looked
    // aborted in DevTools. Read it to EOF instead.
    it("reports the id line that precedes each record, including [DONE]", async () => {
        const ids: string[] = [];
        const frames: unknown[] = [];
        const response = sseResponse([
            'id: 7\ndata: {"a":1}\n\n',
            'data: {"b":2}\n\nid: 9\r\ndata: {"c":3}\r\n\r\n',
            "id: 10\ndata: [DONE]\n\n",
        ]);
        for await (const frame of readSseFrames(response, {
            onEventId: (id) => ids.push(id),
        })) {
            frames.push(frame);
        }
        expect(frames).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
        // A record without an id line reports nothing: the id belongs to
        // the record it precedes, never to a later one.
        expect(ids).toEqual(["7", "9", "10"]);
    });

    it("drains to EOF, not cancel, when the stream ends with [DONE]", async () => {
        const response = sseResponse(['data: {"n":1}\n\n', "data: [DONE]\n\n"]);
        const reader = response.body!.getReader();
        const cancel = vi.spyOn(reader, "cancel");
        vi.spyOn(response, "body", "get").mockReturnValue({
            getReader: () => reader,
        } as unknown as Response["body"]);

        const frames: unknown[] = [];
        for await (const frame of readSseFrames(response)) frames.push(frame);

        expect(frames).toEqual([{ n: 1 }]);
        expect(cancel).not.toHaveBeenCalled();
        // Fully consumed: the next read reports EOF.
        await expect(reader.read()).resolves.toMatchObject({ done: true });
    });

    // A server that sends [DONE] but never closes the body must not hold the
    // caller: past the drain budget the reader is cancelled after all.
    it("cancels after the drain budget when the body never closes", async () => {
        vi.useFakeTimers();
        try {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    // never closes
                },
            });
            const response = new Response(stream, { status: 200 });
            const reader = response.body!.getReader();
            const cancel = vi.spyOn(reader, "cancel");
            vi.spyOn(response, "body", "get").mockReturnValue({
                getReader: () => reader,
            } as unknown as Response["body"]);

            const frames: unknown[] = [];
            const run = (async () => {
                for await (const frame of readSseFrames(response)) frames.push(frame);
            })();
            // Let the generator reach the drain, then expire its budget.
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(2_000);
            await run;

            expect(frames).toEqual([]);
            expect(cancel).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    // A connection torn down between [DONE] and EOF makes the drain's read
    // reject; there is nothing left to release, so no cancel and no throw.
    it("treats a read error during the drain as drained", async () => {
        const encoder = new TextEncoder();
        let reads = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                reads += 1;
                if (reads === 1) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                else controller.error(new Error("connection reset"));
            },
        });
        const response = new Response(stream, { status: 200 });
        const reader = response.body!.getReader();
        const cancel = vi.spyOn(reader, "cancel");
        vi.spyOn(response, "body", "get").mockReturnValue({
            getReader: () => reader,
        } as unknown as Response["body"]);

        const frames: unknown[] = [];
        for await (const frame of readSseFrames(response)) frames.push(frame);

        expect(frames).toEqual([]);
        expect(cancel).not.toHaveBeenCalled();
    });

    it("cancels the reader when the consumer stops early", async () => {
        const response = sseResponse(['data: {"n":1}\n\n', 'data: {"n":2}\n\n']);
        const reader = response.body!.getReader();
        const cancel = vi.spyOn(reader, "cancel");
        vi.spyOn(response, "body", "get").mockReturnValue({
            getReader: () => reader,
        } as unknown as Response["body"]);

        for await (const frame of readSseFrames(response)) {
            expect(frame).toEqual({ n: 1 });
            break;
        }

        expect(cancel).toHaveBeenCalled();
    });

    it("swallows a failing reader.cancel() so the frames still surface", async () => {
        // cancel() rejects on a connection that is already torn down. That is
        // cleanup of a stream the consumer has finished with, so it must not
        // become the caller's error — the frames already read are the result.
        const response = sseResponse(['data: {"n":1}\n\n']);
        const reader = response.body!.getReader();
        vi.spyOn(reader, "cancel").mockRejectedValue(
            new Error("connection already closed"),
        );
        vi.spyOn(response, "body", "get").mockReturnValue({
            getReader: () => reader,
        } as unknown as Response["body"]);

        const frames: unknown[] = [];
        for await (const frame of readSseFrames(response)) frames.push(frame);

        expect(frames).toEqual([{ n: 1 }]);
    });

    it("throws an AbortError once the signal is aborted", async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            collect(['data: {"n":1}\n\n'], { signal: controller.signal }),
        ).rejects.toMatchObject({ name: "AbortError" });
    });

    it("throws when the response has no body", async () => {
        const bodyless = new Response(null, { status: 204 });
        const iterate = async () => {
            for await (const frame of readSseFrames(bodyless)) void frame;
        };

        await expect(iterate()).rejects.toThrow("No response body");
    });
});
