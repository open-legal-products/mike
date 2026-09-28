import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: forkMock }));
import { extractGoogleDriveBinary } from "../googleDriveExtract";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});
it("kills stalled parsers, caps concurrency and does not pass deployment credentials", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GOOGLE_DRIVE_PARSE_TIMEOUT_SECONDS", "2");
    vi.stubEnv("GOOGLE_DRIVE_PARSER_HEAP_MB", "192");
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "never-send-to-parser");
    const children: (EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
    })[] = [];
    forkMock.mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
            kill: vi.fn(),
            send: vi.fn(),
        });
        children.push(child);
        return child;
    });
    const first = expect(
        extractGoogleDriveBinary("/tmp/test-file", "application/pdf"),
    ).rejects.toThrow(/processing limits/);
    const second = expect(
        extractGoogleDriveBinary("/tmp/test-file", "application/pdf"),
    ).rejects.toThrow(/processing limits/);
    await expect(
        extractGoogleDriveBinary("/tmp/test-file", "application/pdf"),
    ).rejects.toThrow(/busy/);
    expect(forkMock).toHaveBeenCalledTimes(2);
    expect(forkMock.mock.calls[0][2].execArgv).toContain(
        "--max-old-space-size=192",
    );
    expect(JSON.stringify(forkMock.mock.calls)).not.toContain(
        "never-send-to-parser",
    );
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all([first, second]);
    for (const child of children)
        expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    const next = extractGoogleDriveBinary("/tmp/test-file", "application/pdf");
    children[2].emit("message", { text: "read successfully" });
    await expect(next).resolves.toBe("read successfully");
});
