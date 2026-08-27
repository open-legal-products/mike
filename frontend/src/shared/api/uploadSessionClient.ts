import { settleWithConcurrency } from "../lib/settleWithConcurrency";

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

export class UploadBatchError extends Error {
    readonly outcomes: UploadOutcome[];

    constructor(message: string, outcomes: UploadOutcome[]) {
        super(message);
        this.name = "UploadBatchError";
        this.outcomes = outcomes;
    }
}

export function failedUploadMessage<T>(
    outcomes: UploadOutcome<T>[],
    fallback = "Documents could not be uploaded. Please try again.",
): string {
    const filenames = outcomes
        .filter((outcome) => outcome.status === "error")
        .map((outcome) => outcome.filename);
    if (filenames.length === 0) return fallback;
    if (filenames.length === 1) {
        return `${filenames[0]} could not be uploaded. Please try again.`;
    }
    return `${filenames.join(", ")} could not be uploaded. Please try again.`;
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

const DIRECT_UPLOAD_CONCURRENCY = 3;
const UPLOAD_PROCESSING_POLL_DELAYS_MS = [
    750, 1_000, 1_500, 2_500, 4_000, 5_000,
];
const UPLOAD_PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_UPLOAD_SESSION_FILES = 50;
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_SESSION_BYTES = 2 * 1024 * 1024 * 1024;

export function uploadProcessingPollDelayMs(pollCount: number): number {
    const index = Math.min(
        Math.max(0, Math.floor(pollCount)),
        UPLOAD_PROCESSING_POLL_DELAYS_MS.length - 1,
    );
    return UPLOAD_PROCESSING_POLL_DELAYS_MS[index]!;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(
                    signal.reason ?? new DOMException("Aborted", "AbortError"),
                );
            },
            { once: true },
        );
    });
}

function validateInputs(
    inputs: Array<UploadSessionInput & { clientId: string }>,
) {
    if (inputs.length > MAX_UPLOAD_SESSION_FILES) {
        return {
            message: "You can upload at most 50 files at a time.",
            code: "too_many_files",
        };
    }
    if (inputs.some((input) => input.file.size > MAX_UPLOAD_FILE_BYTES)) {
        return {
            message: "Each uploaded file must be 100 MB or smaller.",
            code: "upload_file_too_large",
        };
    }
    if (
        inputs.reduce((total, input) => total + input.file.size, 0) >
        MAX_UPLOAD_SESSION_BYTES
    ) {
        return {
            message: "An upload batch must be 2 GB or smaller.",
            code: "upload_batch_too_large",
        };
    }
    return null;
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
    const inputs = args.files.map((input) => ({
        ...input,
        clientId: input.clientId ?? crypto.randomUUID(),
    }));
    const rejectedInput = validateInputs(inputs);
    if (rejectedInput) {
        throw new UploadBatchError(
            rejectedInput.message,
            inputs.map((input) => ({
                clientId: input.clientId,
                filename: input.file.name,
                status: "error",
                result: null,
                errorCode: rejectedInput.code,
            })),
        );
    }

    const { apiRequest, fetchStorage, shouldRetryControlRequest } =
        args.transport;
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
                            signal: args.signal,
                        });
                    } catch (error) {
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
        const unconfirmedTransfers = transfers
            .map((transfer, index) => ({ transfer, input: inputs[index] }))
            .filter(
                (
                    entry,
                ): entry is {
                    transfer: PromiseRejectedResult;
                    input: (typeof inputs)[number];
                } => entry.transfer.status === "rejected",
            );
        if (unconfirmedTransfers.length > 0) {
            throw new UploadBatchError(
                "One or more uploads were sent, but their status could not be confirmed.",
                unconfirmedTransfers.map(({ input }) => ({
                    clientId: input.clientId,
                    filename: input.file.name,
                    status: "error",
                    result: null,
                    errorCode: "upload_confirmation_failed",
                })),
            );
        }

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
                throw new UploadBatchError(
                    "The upload was received but processing did not finish in time.",
                    current.files.map((file) => ({
                        clientId: file.client_id,
                        filename: file.filename,
                        status: "error",
                        result: null,
                        errorCode: "processing_timeout",
                    })),
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

        return current.files.map<UploadOutcome<T>>((file) => ({
            clientId: file.client_id,
            filename: file.filename,
            status: file.status === "completed" ? "completed" : "error",
            result: file.status === "completed" ? (file.result as T) : null,
            errorCode:
                file.error_code ??
                (file.status === "completed"
                    ? null
                    : (current.session.error_code ?? "processing_failed")),
        }));
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
