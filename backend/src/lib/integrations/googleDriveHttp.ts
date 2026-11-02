import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { googleDriveLimits } from "./googleDriveLimits";
import { AppError, type ErrorKind } from "../appError";

export const GOOGLE_DRIVE_REQUEST_TIMEOUT_MS = 30_000;
/**
 * A Drive failure with a fixed, user-facing message. The message is for the
 * user; the `kind` (default `google.user_error`: something the user can act
 * on) is what Sentry gets, and `status` is Google's HTTP status when the
 * failure was its response, so an outage groups by `dependency_status`.
 */
export class GoogleDriveUserError extends AppError {
    /** Stable machine-readable reason, when a subclass has one. */
    code?: string;
    /** Google's HTTP status when the failure was its response. */
    status?: number;

    constructor(
        message: string,
        options: { kind?: ErrorKind; status?: number; cause?: unknown } = {},
    ) {
        super(options.kind ?? "google.user_error", message, {
            cause: options.cause,
        });
        if (options.status !== undefined) this.status = options.status;
    }
}

/** Fixed, intentional user messages; never expose Google's response body. */
export function googleDriveHttpError(status: number): GoogleDriveUserError {
    if (status === 401)
        return new GoogleDriveUserError(
            "Google Drive access was rejected. Reconnect Google Drive.",
            { kind: "google.auth_failed", status },
        );
    if (status === 403 || status === 404)
        return new GoogleDriveUserError(
            "This Google Drive file is unavailable or access is not permitted.",
            { status },
        );
    if (status === 429)
        return new GoogleDriveUserError(
            "Google Drive is busy. Please try again later.",
            { kind: "google.api_failed", status },
        );
    return new GoogleDriveUserError(
        "Google Drive could not complete the request. Please try again.",
        { kind: "google.api_failed", status },
    );
}

async function consumeGoogleResponse(
    url: string | URL,
    init: RequestInit,
    maxBytes: number,
    onChunk: (chunk: Uint8Array) => Promise<void>,
    options: {
        idleMs: number;
        totalMs: number;
        download?: boolean;
        onResponse?: (response: Response) => void;
    },
): Promise<number> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const totalTimer = setTimeout(() => controller.abort(), options.totalMs);
    let idleTimer = setTimeout(() => controller.abort(), options.idleMs);
    const progress = () => {
        if (controller.signal.aborted) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(), options.idleMs);
    };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
            void reader?.cancel().catch(() => {});
            reject(
                new GoogleDriveUserError(
                    "Google Drive took too long to respond. Please try again.",
                ),
            );
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([
            aborted,
            (async () => {
                const response = await fetch(url, {
                    ...init,
                    redirect: "error",
                    signal: controller.signal,
                });
                options.onResponse?.(response);
                reader = response.body?.getReader();
                const tooLarge = () =>
                    new GoogleDriveUserError(
                        options.download
                            ? `This Drive file exceeds this server's ${maxBytes / 1024 / 1024} MiB download limit. Open it in Google Drive.`
                            : "Google Drive returned a response that is too large. Please try a smaller request.",
                    );
                if (controller.signal.aborted) {
                    await reader?.cancel();
                    throw new GoogleDriveUserError(
                        "Google Drive took too long to respond. Please try again.",
                    );
                }
                if (options.download && !response.ok) {
                    await reader?.cancel();
                    throw googleDriveHttpError(response.status);
                }
                if (Number(response.headers.get("content-length")) > maxBytes) {
                    await reader?.cancel();
                    throw tooLarge();
                }
                progress();
                let size = 0;
                if (reader) {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        size += value.byteLength;
                        if (size > maxBytes) {
                            await reader.cancel();
                            throw tooLarge();
                        }
                        if (controller.signal.aborted)
                            throw new Error("request aborted");
                        await onChunk(value);
                        progress();
                    }
                }
                return response.status;
            })(),
        ]);
    } finally {
        clearTimeout(totalTimer);
        clearTimeout(idleTimer);
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
        // Also stop a body if the sink (e.g. a full disk) failed.
        void reader?.cancel().catch(() => {});
    }
}

/** OAuth/metadata are small and remain bounded in memory. */
export async function googleDriveRequest(
    url: string | URL,
    init: RequestInit = {},
    maxBytes = 1024 * 1024,
): Promise<Response> {
    const chunks: Uint8Array[] = [];
    const headers = new Headers();
    const status = await consumeGoogleResponse(
        url,
        init,
        maxBytes,
        async (chunk) => {
            chunks.push(chunk);
        },
        {
            idleMs: GOOGLE_DRIVE_REQUEST_TIMEOUT_MS,
            totalMs: GOOGLE_DRIVE_REQUEST_TIMEOUT_MS,
            onResponse: (response) => {
                const etag = response.headers.get("etag");
                if (etag) headers.set("etag", etag);
            },
        },
    );
    return new Response(status === 204 ? null : Buffer.concat(chunks), {
        status,
        headers,
    });
}

/** Content goes to a private temporary directory, not an API-process buffer.
 * Every caller must use cleanup in finally, including parser failures. */
export async function downloadGoogleDriveFile(
    url: URL,
    token: string,
): Promise<{ filename: string; cleanup: () => Promise<void> }> {
    const limits = googleDriveLimits();
    const directory = await mkdtemp(path.join(os.tmpdir(), "mike-drive-"));
    const filename = path.join(directory, "content");
    const cleanup = () => rm(directory, { recursive: true, force: true });
    try {
        const file = await open(filename, "wx", 0o600);
        try {
            await consumeGoogleResponse(
                url,
                { headers: { Authorization: `Bearer ${token}` } },
                limits.downloadBytes,
                async (chunk) => {
                    // FileHandle.write may write fewer bytes than requested.
                    let offset = 0;
                    while (offset < chunk.byteLength) {
                        const { bytesWritten } = await file.write(
                            chunk,
                            offset,
                            chunk.byteLength - offset,
                        );
                        if (!bytesWritten)
                            throw new Error("No download write progress");
                        offset += bytesWritten;
                    }
                },
                {
                    idleMs: limits.idleMs,
                    totalMs: limits.totalMs,
                    download: true,
                },
            );
        } finally {
            await file.close();
        }
        return { filename, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
