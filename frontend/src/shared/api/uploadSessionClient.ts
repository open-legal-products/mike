import { settleWithConcurrency } from "../lib/settleWithConcurrency";
import { createSecureUuid } from "../lib/secureUuid";

export type UploadSessionPurpose =
    | "document_create"
    | "document_version_create"
    | "document_version_replace"
    | "workflow_reference_create"
    | "workflow_reference_replace";

export type UploadSessionInput = {
    file: File;
    clientId?: string;
    folderId?: string | null;
};

export type UploadOutcome<T = unknown> = {
    clientId: string;
    filename: string;
    status: "completed" | "error";
    result: T | null;
    errorCode: string | null;
};

export type UploadProgressStatus =
    | "pending"
    | "uploading"
    | "uploaded"
    | "processing"
    | "completed"
    | "error";

export type UploadProgress<T = unknown> = Omit<UploadOutcome<T>, "status"> & {
    status: UploadProgressStatus;
};

/**
 * Expected outcomes travel in the return value of
 * `uploadFilesWithSessionCore`, not in a throw: every file that was sent gets
 * a per-file outcome. This error type stays for API compatibility and for the
 * genuinely exceptional paths (a caller abort, or a control-plane failure that
 * left the batch with nothing to report). When it is thrown it still carries
 * an outcome for every file the caller handed in.
 */
export class UploadBatchError extends Error {
    readonly outcomes: UploadOutcome[];

    constructor(message: string, outcomes: UploadOutcome[]) {
        super(message);
        this.name = "UploadBatchError";
        this.outcomes = outcomes;
    }
}

const DIRECT_UPLOAD_CONCURRENCY = 3;
const UPLOAD_PROCESSING_POLL_DELAYS_MS = [
    750, 1_000, 1_500, 2_500, 4_000, 5_000,
];
const UPLOAD_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
/** A single storage PUT that stalls this long is retried, not waited on. */
const PUT_TIMEOUT_MS = 120 * 1000;
const MAX_UPLOAD_SESSION_FILES = 50;
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_SESSION_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The limit constants are the single source for both the enforcement above and
 * the copy below, so a limit change cannot leave a stale number in the UI.
 */
export const UPLOAD_LIMIT_MESSAGES: Record<string, string> = {
    too_many_files: `You can upload at most ${MAX_UPLOAD_SESSION_FILES} files at a time.`,
    upload_file_too_large: `Each uploaded file must be ${Math.round(
        MAX_UPLOAD_FILE_BYTES / (1024 * 1024),
    )} MB or smaller.`,
    upload_batch_too_large: `An upload batch must be ${Math.round(
        MAX_UPLOAD_SESSION_BYTES / (1024 * 1024 * 1024),
    )} GB or smaller.`,
};

/**
 * Prefer the actionable reason over a filename list: when every failure shares
 * one validation code, the limit itself is what the user has to act on.
 *
 * Known layering compromise: user-facing copy lives in this shared client
 * because both the web app and the add-in already call it for exactly this
 * message. Moving copy to the hosts is a separate change.
 */
export function failedUploadMessage<T>(
    outcomes: UploadOutcome<T>[],
    fallback = "Documents could not be uploaded. Please try again.",
): string {
    const failures = outcomes.filter((outcome) => outcome.status === "error");
    if (failures.length === 0) return fallback;
    const codes = new Set(failures.map((outcome) => outcome.errorCode));
    if (codes.size === 1) {
        const limitMessage = UPLOAD_LIMIT_MESSAGES[[...codes][0] ?? ""];
        if (limitMessage) return limitMessage;
    }
    const filenames = failures.map((outcome) => outcome.filename);
    if (filenames.length === 1) {
        return `${filenames[0]} could not be uploaded. Please try again.`;
    }
    return `${filenames.join(", ")} could not be uploaded. Please try again.`;
}

/**
 * The single-file convenience wrappers in both apps unwrap one outcome. Failing
 * with an UploadBatchError keeps the per-file accounting reachable instead of
 * flattening it into a bare message.
 */
export function firstUploadResult<T>(outcomes: UploadOutcome<T>[]): T {
    const first = outcomes[0];
    if (!first || first.status !== "completed" || !first.result) {
        throw new UploadBatchError("The file could not be processed.", outcomes);
    }
    return first.result;
}

/**
 * Retry policy for the session control plane, shared by both apps. Each host
 * passes an extractor for its own API error class; anything the extractor does
 * not recognize is treated as a transport failure and retried.
 */
export function createControlRequestRetryPolicy(
    describeApiError: (
        error: unknown,
    ) => { status: number; code: string | null } | null,
): (error: unknown) => boolean {
    return (error: unknown) => {
        const described = describeApiError(error);
        if (!described) return true;
        return (
            described.status >= 500 ||
            described.status === 429 ||
            described.code === "upload_incomplete" ||
            described.code === "upload_completion_in_progress"
        );
    };
}

type UploadSessionFileResponse = {
    id: string;
    client_id: string;
    filename: string;
    status:
        | "pending_upload"
        | "verifying"
        | "uploaded"
        | "processing"
        | "completed"
        | "error";
    error_code: string | null;
    result: unknown;
    upload?: {
        method: "PUT";
        url: string;
        headers: Record<string, string>;
    };
};

type UploadSessionResponse = {
    session: { id: string; status: string; error_code?: string | null };
    files: UploadSessionFileResponse[];
};

type UploadSessionTransport = {
    apiRequest<T>(path: string, init?: RequestInit): Promise<T>;
    fetchStorage: typeof fetch;
    shouldRetryControlRequest(error: unknown): boolean;
};

type ResolvedInput = UploadSessionInput & { clientId: string };

export function uploadProcessingPollDelayMs(pollCount: number): number {
    const index = Math.min(
        Math.max(0, Math.floor(pollCount)),
        UPLOAD_PROCESSING_POLL_DELAYS_MS.length - 1,
    );
    return UPLOAD_PROCESSING_POLL_DELAYS_MS[index]!;
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException("Aborted", "AbortError");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortReason(signal));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(abortReason(signal));
            },
            { once: true },
        );
    });
}

/**
 * A stalled PUT must not hold a slot forever, but the caller's abort has to
 * stay distinguishable from the timeout (only the former ends the batch).
 * AbortSignal.any/timeout exist in every browser and Office WebView this ships
 * to; the guard only covers older test/runtime hosts.
 */
function storageAttemptSignal(signal?: AbortSignal): AbortSignal | undefined {
    if (typeof AbortSignal?.timeout !== "function") return signal;
    const timeout = AbortSignal.timeout(PUT_TIMEOUT_MS);
    if (!signal) return timeout;
    if (typeof AbortSignal.any !== "function") return signal;
    return AbortSignal.any([signal, timeout]);
}

/**
 * A file larger than the per-file ceiling can never be sent, but it must not
 * take the rest of the selection down with it: it becomes its own error
 * outcome. Everything else is partitioned into sessions that respect the
 * per-session file count and byte budget.
 */
function chunkUploadInputs(inputs: ResolvedInput[]): ResolvedInput[][] {
    const chunks: ResolvedInput[][] = [];
    let current: ResolvedInput[] = [];
    let currentBytes = 0;
    for (const input of inputs) {
        if (
            current.length > 0 &&
            (current.length >= MAX_UPLOAD_SESSION_FILES ||
                currentBytes + input.file.size > MAX_UPLOAD_SESSION_BYTES)
        ) {
            chunks.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(input);
        currentBytes += input.file.size;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

export async function uploadFilesWithSessionCore<T>(args: {
    purpose: UploadSessionPurpose;
    destination: Record<string, unknown>;
    files: UploadSessionInput[];
    transport: UploadSessionTransport;
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress<T>) => void;
}): Promise<UploadOutcome<T>[]> {
    if (args.files.length === 0) return [];
    const inputs: ResolvedInput[] = args.files.map((input) => ({
        ...input,
        clientId: input.clientId ?? createSecureUuid(),
    }));

    const reportedProgress = new Map<string, string>();
    const reportProgress = (progress: UploadProgress<T>) => {
        const signature = `${progress.status}:${progress.errorCode ?? ""}:${progress.result ? "result" : ""}`;
        if (reportedProgress.get(progress.clientId) === signature) return;
        reportedProgress.set(progress.clientId, signature);
        try {
            args.onProgress?.(progress);
        } catch {
            // UI progress reporting must never interrupt the upload itself.
        }
    };

    const outcomes = new Map<string, UploadOutcome<T>>();
    const eligible: ResolvedInput[] = [];
    for (const input of inputs) {
        if (input.file.size > MAX_UPLOAD_FILE_BYTES) {
            const outcome: UploadOutcome<T> = {
                clientId: input.clientId,
                filename: input.file.name,
                status: "error",
                result: null,
                errorCode: "upload_file_too_large",
            };
            outcomes.set(input.clientId, outcome);
            reportProgress(outcome);
            continue;
        }
        eligible.push(input);
    }

    const accounting = () =>
        inputs.map<UploadOutcome<T>>(
            (input) =>
                outcomes.get(input.clientId) ?? {
                    clientId: input.clientId,
                    filename: input.file.name,
                    status: "error",
                    result: null,
                    errorCode: "processing_failed",
                },
        );

    // Sessions run one after another: the per-session limits exist to bound
    // what the backend reserves at once, so parallel sessions would defeat them.
    for (const chunk of chunkUploadInputs(eligible)) {
        try {
            const chunkOutcomes = await runUploadSession<T>({
                purpose: args.purpose,
                destination: args.destination,
                inputs: chunk,
                transport: args.transport,
                signal: args.signal,
                reportProgress,
            });
            for (const outcome of chunkOutcomes) {
                outcomes.set(outcome.clientId, outcome);
            }
        } catch (error) {
            // An abandoned batch stays exceptional, and so does a failure with
            // nothing to show for it — the caller sees the original error. But
            // once a session has landed documents, that accounting must survive
            // a later session's failure, so it rides on the error instead.
            if (
                args.signal?.aborted ||
                !accounting().some((outcome) => outcome.status === "completed")
            ) {
                throw error;
            }
            throw new UploadBatchError(
                error instanceof Error
                    ? error.message
                    : "Some documents could not be uploaded.",
                accounting(),
            );
        }
    }

    return accounting();
}

async function runUploadSession<T>(args: {
    purpose: UploadSessionPurpose;
    destination: Record<string, unknown>;
    inputs: ResolvedInput[];
    transport: UploadSessionTransport;
    signal?: AbortSignal;
    reportProgress: (progress: UploadProgress<T>) => void;
}): Promise<UploadOutcome<T>[]> {
    const { apiRequest, fetchStorage, shouldRetryControlRequest } =
        args.transport;
    const inputs = args.inputs;
    const reportProgress = args.reportProgress;
    const reportResponse = (response: UploadSessionResponse) => {
        for (const file of response.files) {
            reportProgress({
                clientId: file.client_id,
                filename: file.filename,
                status:
                    file.status === "pending_upload"
                        ? "pending"
                        : file.status === "verifying"
                          ? "uploaded"
                          : file.status,
                result: file.status === "completed" ? (file.result as T) : null,
                errorCode: file.error_code,
            });
        }
    };
    const created = await apiRequest<UploadSessionResponse>(
        "/upload-sessions",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                purpose: args.purpose,
                destination: args.destination,
                files: inputs.map((input) => ({
                    client_id: input.clientId,
                    filename: input.file.name,
                    size_bytes: input.file.size,
                    folder_id: input.folderId,
                })),
            }),
            signal: args.signal,
        },
    );
    const sessionId = created.session.id;
    reportResponse(created);
    let descriptors = new Map(
        created.files.map((file) => [file.client_id, file]),
    );
    let refreshInFlight: Promise<void> | null = null;
    const refreshUrls = async () => {
        if (!refreshInFlight) {
            refreshInFlight = apiRequest<{
                files: UploadSessionFileResponse[];
            }>(`/upload-sessions/${sessionId}/urls`, {
                method: "POST",
                signal: args.signal,
            })
                .then(({ files }) => {
                    descriptors = new Map(
                        files.map((file) => [file.client_id, file]),
                    );
                })
                .finally(() => {
                    refreshInFlight = null;
                });
        }
        await refreshInFlight;
    };
    const completeFile = async (
        descriptor: UploadSessionFileResponse,
        failed: boolean,
    ) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const response = await apiRequest<UploadSessionResponse>(
                    `/upload-sessions/${sessionId}/files/${descriptor.id}/complete`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ failed }),
                        signal: args.signal,
                    },
                );
                reportResponse(response);
                return;
            } catch (error) {
                if (
                    args.signal?.aborted ||
                    !shouldRetryControlRequest(error) ||
                    attempt === 2
                ) {
                    throw error;
                }
                await delay(400 * (attempt + 1), args.signal);
            }
        }
    };

    try {
        const transfers = await settleWithConcurrency(
            inputs,
            DIRECT_UPLOAD_CONCURRENCY,
            async (input) => {
                reportProgress({
                    clientId: input.clientId,
                    filename: input.file.name,
                    status: "uploading",
                    result: null,
                    errorCode: null,
                });
                let lastError: unknown;
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    if (attempt > 0) {
                        try {
                            await refreshUrls();
                        } catch (error) {
                            if (args.signal?.aborted) throw error;
                            lastError = error;
                            continue;
                        }
                    }
                    const descriptor = descriptors.get(input.clientId);
                    if (!descriptor?.upload) {
                        lastError = new Error("Upload URL is unavailable");
                        continue;
                    }
                    let response: Response;
                    try {
                        response = await fetchStorage(descriptor.upload.url, {
                            method: descriptor.upload.method,
                            headers: descriptor.upload.headers,
                            body: input.file,
                            signal: storageAttemptSignal(args.signal),
                        });
                    } catch (error) {
                        // A caller abort ends the batch; the per-attempt
                        // timeout is just another failed attempt.
                        if (args.signal?.aborted) throw error;
                        lastError = error;
                        continue;
                    }
                    if (response.ok) {
                        reportProgress({
                            clientId: input.clientId,
                            filename: input.file.name,
                            status: "uploaded",
                            result: null,
                            errorCode: null,
                        });
                        await completeFile(descriptor, false);
                        return { status: "uploaded" as const };
                    }
                    lastError = new Error(
                        `Object storage returned ${response.status}`,
                    );
                }
                const descriptor = descriptors.get(input.clientId);
                if (descriptor) {
                    await completeFile(descriptor, true);
                }
                reportProgress({
                    clientId: input.clientId,
                    filename: input.file.name,
                    status: "error",
                    result: null,
                    errorCode: "direct_upload_failed",
                });
                return {
                    status: "error" as const,
                    error: lastError ?? new Error("Direct upload failed"),
                };
            },
        );
        // settleWithConcurrency absorbs rejections, so an abort that landed
        // inside a transfer has to be re-raised here.
        if (args.signal?.aborted) throw abortReason(args.signal);

        // A file whose `complete` call never landed is NOT a failed file: the
        // bytes may well be in storage, and the server reconciles it on its own
        // schedule. Keep polling and let the server have the last word; only a
        // file it still cannot account for is reported as unconfirmed.
        const unconfirmed = new Set(
            transfers.flatMap((transfer, index) =>
                transfer.status === "rejected" && inputs[index]
                    ? [inputs[index]!.clientId]
                    : [],
            ),
        );

        const isTerminalFile = (file: UploadSessionFileResponse) =>
            file.status === "completed" || file.status === "error";
        const toOutcome = (
            file: UploadSessionFileResponse,
            session: UploadSessionResponse["session"],
        ): UploadOutcome<T> => ({
            clientId: file.client_id,
            filename: file.filename,
            status: file.status === "completed" ? "completed" : "error",
            result: file.status === "completed" ? (file.result as T) : null,
            errorCode:
                file.status === "completed"
                    ? null
                    : (file.error_code ??
                      (unconfirmed.has(file.client_id) && !isTerminalFile(file)
                          ? "upload_confirmation_failed"
                          : (session.error_code ?? "processing_failed"))),
        });

        let current = created;
        const processingDeadline = Date.now() + UPLOAD_PROCESSING_TIMEOUT_MS;
        let pollCount = 0;
        let pollImmediately = true;
        while (
            !["completed", "error", "expired", "cancelled"].includes(
                current.session.status,
            )
        ) {
            if (Date.now() >= processingDeadline) {
                // Files the server already finished stay finished. Only the
                // ones still in flight are reported as timed out.
                return current.files.map<UploadOutcome<T>>((file) =>
                    file.status === "completed" || file.status === "error"
                        ? toOutcome(file, current.session)
                        : {
                              clientId: file.client_id,
                              filename: file.filename,
                              status: "error",
                              result: null,
                              errorCode: "processing_timeout",
                          },
                );
            }
            if (!pollImmediately) {
                await delay(
                    uploadProcessingPollDelayMs(pollCount),
                    args.signal,
                );
                pollCount += 1;
            }
            pollImmediately = false;
            try {
                current = await apiRequest<UploadSessionResponse>(
                    `/upload-sessions/${sessionId}`,
                    { signal: args.signal },
                );
            } catch (error) {
                if (args.signal?.aborted || !shouldRetryControlRequest(error)) {
                    throw error;
                }
                continue;
            }
            reportResponse(current);
        }

        return current.files.map<UploadOutcome<T>>((file) =>
            toOutcome(file, current.session),
        );
    } catch (error) {
        // An explicit caller abort means the batch is intentionally abandoned.
        // For control-plane/network failures, preserve the session: some files may
        // already be processing, and pending files have server-side TTL cleanup.
        if (args.signal?.aborted) {
            await apiRequest(`/upload-sessions/${sessionId}`, {
                method: "DELETE",
            }).catch(() => undefined);
        }
        throw error;
    }
}
