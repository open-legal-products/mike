import { afterEach, describe, expect, it, vi } from "vitest";
import {
    downloadGoogleDriveFile,
    googleDriveRequest,
    GOOGLE_DRIVE_REQUEST_TIMEOUT_MS,
} from "../googleDriveHttp";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});
describe("bounded Google transport", () => {
    it("rejects an oversized Content-Length without consuming its body", async () => {
        const cancel = vi.fn();
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(new ReadableStream({ cancel }), {
                        headers: { "content-length": "100" },
                    }),
            ),
        );
        await expect(
            googleDriveRequest("https://www.googleapis.com/test", {}, 10),
        ).rejects.toThrow(/too large/);
        expect(cancel).toHaveBeenCalledOnce();
    });
    it.each<Record<string, string>>([{}, { "content-length": "1" }])(
        "limits actual streamed bytes even with missing/false headers %j",
        async (headers) => {
            const cancel = vi.fn();
            let reads = 0;
            vi.stubGlobal(
                "fetch",
                vi.fn(
                    async () =>
                        new Response(
                            new ReadableStream({
                                pull(controller) {
                                    reads++;
                                    controller.enqueue(new Uint8Array(8));
                                },
                                cancel,
                            }),
                            { headers },
                        ),
                ),
            );
            await expect(
                googleDriveRequest("https://www.googleapis.com/test", {}, 10),
            ).rejects.toThrow(/too large/);
            expect(cancel).toHaveBeenCalledOnce();
            expect(reads).toBeLessThanOrEqual(3);
        },
    );
    it("preserves status and bytes within the exact limit and forbids redirects", async () => {
        const fetchMock = vi.fn(
            async (_input: unknown, _init?: RequestInit) =>
                new Response("1234567890", { status: 403 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const result = await googleDriveRequest(
            "https://www.googleapis.com/test",
            {},
            10,
        );
        expect(result.status).toBe(403);
        expect(await result.text()).toBe("1234567890");
        expect(fetchMock.mock.calls[0][1]).toMatchObject({
            redirect: "error",
            signal: expect.any(AbortSignal),
        });
    });
    it("aborts a stalled response body as well as a stalled fetch", async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new ReadableStream({ cancel }))),
        );
        const result = googleDriveRequest("https://www.googleapis.com/test");
        const assertion = expect(result).rejects.toThrow(/too long/);
        await vi.advanceTimersByTimeAsync(GOOGLE_DRIVE_REQUEST_TIMEOUT_MS);
        await assertion;
        expect(cancel).toHaveBeenCalledOnce();
    });
    it("bounds a stalled fetch even if the transport ignores abort", async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            "fetch",
            vi.fn(() => new Promise(() => {})),
        );
        const assertion = expect(
            googleDriveRequest("https://www.googleapis.com/test"),
        ).rejects.toThrow(/too long/);
        await vi.advanceTimersByTimeAsync(GOOGLE_DRIVE_REQUEST_TIMEOUT_MS);
        await assertion;
    });
});

describe("disk-backed file downloads and configurable budgets", () => {
    it("supports files above the former 10 MiB limit without buffering them in a Response", async () => {
        const { stat } = await import("node:fs/promises");
        let sent = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream({
                            pull(controller) {
                                if (sent++ === 11) controller.close();
                                else
                                    controller.enqueue(
                                        new Uint8Array(1024 * 1024),
                                    );
                            },
                        }),
                    ),
            ),
        );
        const downloaded = await downloadGoogleDriveFile(
            new URL("https://www.googleapis.com/file"),
            "token",
        );
        try {
            expect((await stat(downloaded.filename)).size).toBe(
                11 * 1024 * 1024,
            );
        } finally {
            await downloaded.cleanup();
        }
        await expect(stat(downloaded.filename)).rejects.toThrow();
    });
    it("allows a progressing transfer to continue beyond 30 seconds", async () => {
        vi.useFakeTimers();
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        let pulls = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream(
                            {
                                start(controller) {
                                    stream = controller;
                                },
                                pull() {
                                    pulls++;
                                },
                            },
                            { highWaterMark: 0 },
                        ),
                    ),
            ),
        );
        const result = downloadGoogleDriveFile(
            new URL("https://www.googleapis.com/file"),
            "token",
        );
        // With no prefetch, the next pull proves the previous disk write and
        // idle-timer reset finished. Fake time must not outrun real filesystem IO.
        await vi.waitFor(() => expect(pulls).toBe(1));
        for (let i = 0; i < 4; i++) {
            stream.enqueue(new Uint8Array(1));
            await vi.waitFor(() => expect(pulls).toBe(i + 2));
            await vi.advanceTimersByTimeAsync(10_000);
        }
        stream.close();
        const file = await result;
        await file.cleanup();
    });
});

describe("Drive download configuration", () => {
    it("enforces an operator's smaller size budget on an actual stream", async () => {
        vi.stubEnv("GOOGLE_DRIVE_MAX_FILE_MB", "1");
        const cancel = vi.fn();
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream({
                            pull(controller) {
                                controller.enqueue(new Uint8Array(1024 * 1024));
                            },
                            cancel,
                        }),
                    ),
            ),
        );
        await expect(
            downloadGoogleDriveFile(
                new URL("https://www.googleapis.com/file"),
                "token",
            ),
        ).rejects.toThrow("1 MiB");
        expect(cancel).toHaveBeenCalledOnce();
    });
});
