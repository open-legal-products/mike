import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));
vi.mock("@/app/lib/supabase", () => ({
    supabase: { auth: { getSession: getSessionMock } },
}));

import {
    UploadBatchError,
    failedUploadMessage,
    replaceDocumentVersionFile,
    replaceWorkflowReferenceFile,
    uploadDocumentVersion,
    uploadFilesWithSession,
    uploadLibraryDocument,
    uploadLibraryDocuments,
    uploadProjectDocuments,
    uploadReviewDocument,
    uploadStandaloneDocument,
    uploadStandaloneDocuments,
    uploadWorkflowReferenceFile,
} from "./mikeApi";
import { uploadProcessingPollDelayMs } from "@/shared/api/uploadSessionClient";

const fetchMock = vi.fn();
const API_URL = "/api";

type Manifest = {
    purpose: string;
    destination: Record<string, unknown>;
    files: Array<{
        client_id: string;
        filename: string;
        size_bytes: number;
        folder_id?: string | null;
    }>;
};

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function installSuccessfulSessionServer(options?: {
    storageUpload?: (
        url: string,
        init: RequestInit,
    ) => Promise<Response> | Response;
    /** Return null to fall through to the default completion behaviour. */
    fileCompletion?: (
        url: string,
        init: RequestInit,
    ) => Promise<Response | null> | Response | null;
    statusPollFailures?: number;
    processingPollsBeforeComplete?: number;
    /**
     * Model the backend reconciling a file whose `complete` call never landed:
     * a status poll finds the object in storage and finishes the file anyway.
     */
    resolvePendingUploadsOnPoll?: boolean;
    /** These filenames never leave `processing`, so a batch can time out. */
    stuckFilenames?: string[];
    /** Hand back a different upload URL once the client refreshes. */
    rotateUrlsOnRefresh?: boolean;
}) {
    const manifests: Manifest[] = [];
    const sessionManifests = new Map<string, Manifest>();
    const filenames = new Map<string, string>();
    const states = new Map<
        string,
        {
            status: "pending_upload" | "processing" | "completed" | "error";
            error_code: string | null;
        }
    >();
    const storageRequests: Array<{ url: string; init: RequestInit }> = [];
    let activeStorageUploads = 0;
    let maximumStorageUploads = 0;
    let statusRequestCount = 0;
    let refreshedUrls = false;
    const isStuck = (clientId: string) =>
        (options?.stuckFilenames ?? []).includes(filenames.get(clientId) ?? "");
    const uploadUrl = (clientId: string) =>
        refreshedUrls && options?.rotateUrlsOnRefresh
            ? `https://storage.test/refreshed/${clientId}`
            : `https://storage.test/${clientId}`;
    const uploadFiles = (manifest: Manifest) =>
        manifest.files.map((file) => ({
            id: file.client_id,
            client_id: file.client_id,
            filename: file.filename,
            status: "pending_upload",
            error_code: null,
            result: null,
            upload: {
                method: "PUT",
                url: uploadUrl(file.client_id),
                headers: { "Content-Type": "application/pdf" },
            },
        }));
    const sessionResponse = (sessionId: string, finishProcessing = false) => {
        const manifest = sessionManifests.get(sessionId)!;
        if (finishProcessing) {
            for (const [clientId, state] of states) {
                if (state.status === "processing" && !isStuck(clientId)) {
                    state.status = "completed";
                }
            }
        }
        const files = manifest.files.map((file) => {
            const state = states.get(file.client_id) ?? {
                status: "pending_upload" as const,
                error_code: null,
            };
            return {
                id: file.client_id,
                client_id: file.client_id,
                filename: file.filename,
                status: state.status,
                error_code: state.error_code,
                result:
                    state.status === "completed"
                        ? { id: `result-${file.filename}` }
                        : null,
            };
        });
        const hasPending = files.some((file) =>
            ["pending_upload"].includes(file.status),
        );
        const hasProcessing = files.some(
            (file) => file.status === "processing",
        );
        const hasCompleted = files.some((file) => file.status === "completed");
        return {
            session: {
                id: sessionId,
                status: hasPending
                    ? "pending_upload"
                    : hasProcessing
                      ? "processing"
                      : hasCompleted
                        ? "completed"
                        : "error",
                error_code:
                    !hasPending &&
                    !hasProcessing &&
                    hasCompleted &&
                    files.some((file) => file.status === "error")
                        ? "partial_failure"
                        : null,
                expires_at: "2099-01-01T00:00:00Z",
            },
            files,
        };
    };

    fetchMock.mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url === `${API_URL}/upload-sessions` &&
                init?.method === "POST"
            ) {
                const manifest = JSON.parse(String(init.body)) as Manifest;
                manifests.push(manifest);
                const sessionId = `session-${manifests.length}`;
                sessionManifests.set(sessionId, manifest);
                for (const file of manifest.files) {
                    filenames.set(file.client_id, file.filename);
                    states.set(file.client_id, {
                        status: "pending_upload",
                        error_code: null,
                    });
                }
                return json(
                    {
                        session: {
                            id: sessionId,
                            status: "pending_upload",
                            expires_at: "2099-01-01T00:00:00Z",
                        },
                        files: uploadFiles(manifest),
                    },
                    201,
                );
            }
            const refresh = url.match(
                new RegExp(`^${API_URL}/upload-sessions/([^/]+)/urls$`),
            );
            if (refresh && init?.method === "POST") {
                refreshedUrls = true;
                return json({
                    files: uploadFiles(sessionManifests.get(refresh[1]!)!),
                });
            }
            if (url.startsWith("https://storage.test/")) {
                storageRequests.push({ url, init: init ?? {} });
                activeStorageUploads += 1;
                maximumStorageUploads = Math.max(
                    maximumStorageUploads,
                    activeStorageUploads,
                );
                try {
                    return options?.storageUpload
                        ? await options.storageUpload(url, init ?? {})
                        : new Response(null, { status: 200 });
                } finally {
                    activeStorageUploads -= 1;
                }
            }
            const fileCompletion = url.match(
                new RegExp(
                    `^${API_URL}/upload-sessions/([^/]+)/files/([^/]+)/complete$`,
                ),
            );
            if (fileCompletion && init?.method === "POST") {
                const override = await options?.fileCompletion?.(url, init);
                if (override) return override;
                const sessionId = fileCompletion[1]!;
                const completedClientId = decodeURIComponent(
                    fileCompletion[2]!,
                );
                const failed = JSON.parse(String(init.body ?? "{}")) as {
                    failed?: boolean;
                };
                states.set(completedClientId, {
                    status: failed.failed ? "error" : "processing",
                    error_code: failed.failed ? "direct_upload_failed" : null,
                });
                return json(sessionResponse(sessionId));
            }
            const session = url.match(
                new RegExp(`^${API_URL}/upload-sessions/([^/]+)$`),
            );
            if (session && init?.method === "DELETE") {
                return new Response(null, { status: 204 });
            }
            if (session && !init?.method) {
                const sessionId = session[1]!;
                statusRequestCount += 1;
                const failedPolls = options?.statusPollFailures ?? 0;
                if (statusRequestCount <= failedPolls) {
                    return json(
                        {
                            code: "upload_session_poll_rate_limit",
                            detail: "Try again shortly",
                        },
                        429,
                    );
                }
                if (options?.resolvePendingUploadsOnPoll) {
                    for (const file of sessionManifests.get(sessionId)!.files) {
                        const state = states.get(file.client_id);
                        if (state?.status === "pending_upload") {
                            state.status = "processing";
                        }
                    }
                }
                const completedPolls = statusRequestCount - failedPolls;
                return json(
                    sessionResponse(
                        sessionId,
                        completedPolls >
                            (options?.processingPollsBeforeComplete ?? 0),
                    ),
                );
            }
            if (
                url.startsWith(`${API_URL}/tabular-review/`) &&
                init?.method === "PATCH"
            ) {
                return json({ id: "review-1" });
            }
            throw new Error(
                `Unexpected request: ${init?.method ?? "GET"} ${url}`,
            );
        },
    );

    return {
        manifests,
        storageRequests,
        maximumStorageUploads: () => maximumStorageUploads,
        statusRequestCount: () => statusRequestCount,
    };
}

/** A File whose reported size is far larger than its bytes. */
function fileOfSize(name: string, size: number): File {
    const file = new File(["x"], name, { type: "application/pdf" });
    Object.defineProperty(file, "size", { value: size });
    return file;
}

describe("direct upload sessions", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getSessionMock.mockResolvedValue({
            data: { session: { access_token: "token-123" } },
        });
        vi.stubGlobal("fetch", fetchMock);
    });

    it("uploads at most three files concurrently and returns every outcome", async () => {
        const server = installSuccessfulSessionServer({
            storageUpload: () =>
                new Promise((resolve) =>
                    setTimeout(
                        () => resolve(new Response(null, { status: 200 })),
                        5,
                    ),
                ),
        });
        const files = Array.from({ length: 7 }, (_, index) => ({
            file: new File([`file-${index}`], `file-${index}.pdf`, {
                type: "application/pdf",
            }),
        }));

        const outcomes = await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files,
        });

        expect(server.maximumStorageUploads()).toBe(3);
        const calls = fetchMock.mock.calls.map(([url]) => String(url));
        const firstFileCompletion = calls.findIndex((url) =>
            url.includes("/files/"),
        );
        expect(firstFileCompletion).toBeGreaterThan(-1);
        expect(calls.some((url) => url.endsWith("/session-1/complete"))).toBe(
            false,
        );
        expect(
            calls.findIndex((url) => url.endsWith("/session-1")),
        ).toBeGreaterThan(firstFileCompletion);
        expect(
            calls
                .slice(0, firstFileCompletion)
                .filter((url) => url.startsWith("https://storage.test/")),
        ).toHaveLength(3);
        expect(outcomes).toHaveLength(7);
        expect(
            outcomes.every((outcome) => outcome.status === "completed"),
        ).toBe(true);
    });

    it("reports each file as it uploads and completes", async () => {
        installSuccessfulSessionServer();
        const progress: Array<{ filename: string; status: string }> = [];

        await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [
                {
                    file: new File(["contract"], "contract.pdf", {
                        type: "application/pdf",
                    }),
                },
            ],
            onProgress: ({ filename, status }) => {
                progress.push({ filename, status });
            },
        });

        expect(progress).toEqual([
            { filename: "contract.pdf", status: "pending" },
            { filename: "contract.pdf", status: "uploading" },
            { filename: "contract.pdf", status: "uploaded" },
            { filename: "contract.pdf", status: "processing" },
            { filename: "contract.pdf", status: "completed" },
        ]);
    });

    it("keeps successful files when another transfer fails", async () => {
        let failedUrl: string | null = null;
        const attempts = new Map<string, number>();
        installSuccessfulSessionServer({
            storageUpload: async (url) => {
                failedUrl ??= url;
                attempts.set(url, (attempts.get(url) ?? 0) + 1);
                return new Response(null, {
                    status: url === failedUrl ? 503 : 200,
                });
            },
        });

        const outcomes = await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [
                { file: new File(["a"], "a.pdf") },
                { file: new File(["b"], "b.pdf") },
            ],
        });

        expect(
            outcomes.filter((outcome) => outcome.status === "completed"),
        ).toHaveLength(1);
        expect(
            outcomes.filter((outcome) => outcome.status === "error"),
        ).toMatchObject([{ errorCode: "direct_upload_failed" }]);
        expect(attempts.get(failedUrl!)).toBe(3);
        expect(failedUploadMessage(outcomes)).toBe(
            "a.pdf could not be uploaded. Please try again.",
        );
    });

    it("keeps polling when a file's completion call cannot be confirmed", async () => {
        // M7: one blocked `complete` must not discard the other files. The
        // server owns the truth about a file whose confirmation never landed.
        let completionAttempts = 0;
        installSuccessfulSessionServer({
            resolvePendingUploadsOnPoll: true,
            processingPollsBeforeComplete: 1,
            fileCompletion: (url) => {
                if (!url.includes("/files/blocked/")) return null;
                completionAttempts += 1;
                return json(
                    { code: "temporary_failure", detail: "Try again" },
                    503,
                );
            },
        });

        const outcomes = await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [
                { clientId: "confirmed", file: new File(["a"], "a.pdf") },
                { clientId: "blocked", file: new File(["b"], "b.pdf") },
            ],
        });

        expect(completionAttempts).toBe(3);
        expect(outcomes).toMatchObject([
            { filename: "a.pdf", status: "completed" },
            { filename: "b.pdf", status: "completed" },
        ]);
        const calls = fetchMock.mock.calls.map(([url, init]) => ({
            url: String(url),
            method: (init as RequestInit | undefined)?.method,
        }));
        expect(
            calls.some(({ url }) => url.endsWith("/session-1/complete")),
        ).toBe(false);
        expect(
            calls.some(
                ({ url, method }) =>
                    url.endsWith("/session-1") && method === "DELETE",
            ),
        ).toBe(false);
    });

    it("reports only the file the server never accounted for as unconfirmed", async () => {
        // The confirmed file completes; the unconfirmed one is still
        // pending_upload when the session reaches a terminal state.
        fetchMock.mockImplementation(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const files = (statuses: Record<string, string>) =>
                    Object.entries(statuses).map(([clientId, status]) => ({
                        id: clientId,
                        client_id: clientId,
                        filename: `${clientId}.pdf`,
                        status,
                        error_code: null,
                        result:
                            status === "completed"
                                ? { id: `result-${clientId}` }
                                : null,
                        upload: {
                            method: "PUT",
                            url: `https://storage.test/${clientId}`,
                            headers: {},
                        },
                    }));
                if (
                    url === `${API_URL}/upload-sessions` &&
                    init?.method === "POST"
                ) {
                    return json(
                        {
                            session: {
                                id: "session-1",
                                status: "pending_upload",
                            },
                            files: files({
                                confirmed: "pending_upload",
                                blocked: "pending_upload",
                            }),
                        },
                        201,
                    );
                }
                if (url.startsWith("https://storage.test/")) {
                    return new Response(null, { status: 200 });
                }
                if (url.includes("/files/blocked/complete")) {
                    return json({ code: "temporary_failure" }, 503);
                }
                if (url.includes("/files/confirmed/complete")) {
                    return json({
                        session: { id: "session-1", status: "processing" },
                        files: files({
                            confirmed: "processing",
                            blocked: "pending_upload",
                        }),
                    });
                }
                if (
                    url === `${API_URL}/upload-sessions/session-1` &&
                    !init?.method
                ) {
                    return json({
                        session: {
                            id: "session-1",
                            status: "error",
                            error_code: null,
                        },
                        files: files({
                            confirmed: "completed",
                            blocked: "pending_upload",
                        }),
                    });
                }
                throw new Error(`Unexpected request: ${url}`);
            },
        );

        const outcomes = await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [
                { clientId: "confirmed", file: new File(["a"], "a.pdf") },
                { clientId: "blocked", file: new File(["b"], "b.pdf") },
            ],
        });

        expect(outcomes).toMatchObject([
            { filename: "confirmed.pdf", status: "completed" },
            {
                filename: "blocked.pdf",
                status: "error",
                errorCode: "upload_confirmation_failed",
            },
        ]);
    });

    it("keeps completed files when processing does not finish in time", async () => {
        // M8: a deadline must not rewrite files the server already finished.
        vi.useFakeTimers();
        try {
            installSuccessfulSessionServer({
                stuckFilenames: ["stuck.pdf"],
                processingPollsBeforeComplete: 1,
            });
            const upload = uploadFilesWithSession<{ id: string }>({
                purpose: "document_create",
                destination: { scope: "standalone" },
                files: [
                    { file: new File(["a"], "done.pdf") },
                    { file: new File(["b"], "stuck.pdf") },
                ],
            });

            await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

            await expect(upload).resolves.toMatchObject([
                {
                    filename: "done.pdf",
                    status: "completed",
                    result: { id: "result-done.pdf" },
                },
                {
                    filename: "stuck.pdf",
                    status: "error",
                    errorCode: "processing_timeout",
                },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("splits an over-limit selection into sequential sessions", async () => {
        // M9: a 51-file selection used to upload nothing at all.
        const server = installSuccessfulSessionServer();

        const outcomes = await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: Array.from({ length: 51 }, (_, index) => ({
                file: new File(["pdf"], `contract-${index}.pdf`),
            })),
        });

        expect(
            server.manifests.map((manifest) => manifest.files.length),
        ).toEqual([50, 1]);
        expect(outcomes).toHaveLength(51);
        expect(
            outcomes.every((outcome) => outcome.status === "completed"),
        ).toBe(true);
        const calls = fetchMock.mock.calls.map(([url, init]) => ({
            url: String(url),
            method: (init as RequestInit | undefined)?.method,
        }));
        const secondSessionCreated = calls.findLastIndex(
            ({ url, method }) =>
                url === `${API_URL}/upload-sessions` && method === "POST",
        );
        const firstSessionPolled = calls.findIndex(
            ({ url, method }) =>
                url === `${API_URL}/upload-sessions/session-1` && !method,
        );
        expect(firstSessionPolled).toBeGreaterThan(-1);
        expect(secondSessionCreated).toBeGreaterThan(firstSessionPolled);
    });

    it("keeps the first session's documents when a later session fails", async () => {
        const server = installSuccessfulSessionServer();
        const create = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                if (
                    String(input) === `${API_URL}/upload-sessions` &&
                    init?.method === "POST" &&
                    server.manifests.length === 1
                ) {
                    return json({ code: "storage_unavailable" }, 503);
                }
                return create(input, init);
            },
        );

        const error = await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: Array.from({ length: 51 }, (_, index) => ({
                file: new File(["pdf"], `contract-${index}.pdf`),
            })),
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(UploadBatchError);
        const outcomes = (error as InstanceType<typeof UploadBatchError>)
            .outcomes;
        expect(outcomes).toHaveLength(51);
        expect(
            outcomes.filter((outcome) => outcome.status === "completed"),
        ).toHaveLength(50);
        expect(outcomes[50]).toMatchObject({
            filename: "contract-50.pdf",
            status: "error",
        });
    });

    it("splits a selection that exceeds the per-session byte budget", async () => {
        const server = installSuccessfulSessionServer();

        // 21 files at the 100 MB per-file ceiling exceed the 2 GB session
        // budget, so the batch has to break across two sessions.
        await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: Array.from({ length: 21 }, (_, index) => ({
                file: fileOfSize(`file-${index}.pdf`, 100 * 1024 * 1024),
            })),
        });

        expect(
            server.manifests.map((manifest) => manifest.files.length),
        ).toEqual([20, 1]);
        expect(server.manifests[1]!.files[0]!.filename).toBe("file-20.pdf");
    });

    it("fails only the oversized file and uploads the rest", async () => {
        const server = installSuccessfulSessionServer();

        const outcomes = await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [
                { file: fileOfSize("huge.pdf", 120 * 1024 * 1024) },
                { file: new File(["pdf"], "small.pdf") },
            ],
        });

        expect(server.manifests).toHaveLength(1);
        expect(server.manifests[0]!.files).toMatchObject([
            { filename: "small.pdf" },
        ]);
        expect(outcomes).toMatchObject([
            {
                filename: "huge.pdf",
                status: "error",
                errorCode: "upload_file_too_large",
            },
            { filename: "small.pdf", status: "completed" },
        ]);
        // m14: a shared validation code names the limit, not the filename.
        expect(failedUploadMessage(outcomes)).toBe(
            "Each uploaded file must be 100 MB or smaller.",
        );
    });

    it("sends the storage PUT without credentials or an Authorization header", async () => {
        const server = installSuccessfulSessionServer();

        await uploadFilesWithSession({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [{ file: new File(["pdf"], "contract.pdf") }],
        });

        expect(server.storageRequests).toHaveLength(1);
        const { init } = server.storageRequests[0]!;
        expect(init.credentials).toBeUndefined();
        expect(
            Object.keys(init.headers as Record<string, string>).map((header) =>
                header.toLowerCase(),
            ),
        ).toEqual(["content-type"]);
        const controlRequest = fetchMock.mock.calls.find(([url]) =>
            String(url).startsWith(`${API_URL}/upload-sessions`),
        );
        expect(
            (controlRequest?.[1] as RequestInit | undefined)?.credentials,
        ).toBe("include");
    });

    it("retries a failed transfer against a refreshed upload URL", async () => {
        const server = installSuccessfulSessionServer({
            rotateUrlsOnRefresh: true,
            storageUpload: (url) =>
                new Response(null, {
                    status: url.includes("/refreshed/") ? 200 : 503,
                }),
        });

        const outcomes = await uploadFilesWithSession<{ id: string }>({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [{ file: new File(["pdf"], "contract.pdf") }],
        });

        expect(outcomes).toMatchObject([{ status: "completed" }]);
        const storageUrls = server.storageRequests.map(({ url }) => url);
        expect(storageUrls).toHaveLength(2);
        expect(storageUrls[0]).not.toBe(storageUrls[1]);
        expect(storageUrls[1]).toContain("/refreshed/");
    });

    it("aborts the batch without reporting an unconfirmed upload", async () => {
        const controller = new AbortController();
        const server = installSuccessfulSessionServer({
            storageUpload: () => {
                controller.abort();
                throw new DOMException("Aborted", "AbortError");
            },
        });
        const progress: string[] = [];

        const error = await uploadFilesWithSession({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [
                { file: new File(["a"], "a.pdf") },
                { file: new File(["b"], "b.pdf") },
            ],
            signal: controller.signal,
            onProgress: ({ errorCode }) => {
                if (errorCode) progress.push(errorCode);
            },
        }).catch((caught: unknown) => caught);

        expect((error as Error).name).toBe("AbortError");
        expect(progress).not.toContain("upload_confirmation_failed");
        expect(server.storageRequests.length).toBeGreaterThan(0);
        expect(
            fetchMock.mock.calls.some(
                ([url, init]) =>
                    String(url) === `${API_URL}/upload-sessions/session-1` &&
                    (init as RequestInit | undefined)?.method === "DELETE",
            ),
        ).toBe(true);
    });

    it("sends project and per-file folder destinations in one manifest", async () => {
        const server = installSuccessfulSessionServer();
        const file = new File(["pdf"], "contract.pdf", {
            type: "application/pdf",
        });

        await uploadProjectDocuments("11111111-1111-4111-8111-111111111111", [
            { file, folderId: "22222222-2222-4222-8222-222222222222" },
        ]);

        expect(server.manifests[0]).toMatchObject({
            purpose: "document_create",
            destination: {
                scope: "project",
                project_id: "11111111-1111-4111-8111-111111111111",
            },
            files: [
                {
                    filename: "contract.pdf",
                    folder_id: "22222222-2222-4222-8222-222222222222",
                },
            ],
        });
    });

    it("uses upload sessions for standalone and library convenience APIs", async () => {
        const server = installSuccessfulSessionServer();
        const progress = vi.fn();
        const standaloneFile = new File(["standalone"], "standalone.pdf", {
            type: "application/pdf",
        });
        const libraryFile = new File(["library"], "library.pdf", {
            type: "application/pdf",
        });

        await expect(uploadStandaloneDocument(standaloneFile)).resolves.toEqual(
            { id: "result-standalone.pdf" },
        );
        await uploadStandaloneDocuments([{ file: standaloneFile }], {
            onProgress: progress,
        });
        await expect(
            uploadLibraryDocument("files", libraryFile, "folder-1"),
        ).resolves.toEqual({ id: "result-library.pdf" });
        await uploadLibraryDocuments(
            "templates",
            [{ file: libraryFile, folderId: null }],
            { onProgress: progress },
        );

        expect(server.manifests).toMatchObject([
            { destination: { scope: "standalone" } },
            { destination: { scope: "standalone" } },
            {
                destination: { scope: "library", library_kind: "file" },
                files: [{ folder_id: "folder-1" }],
            },
            {
                destination: { scope: "library", library_kind: "template" },
                files: [{ folder_id: null }],
            },
        ]);
        expect(progress).toHaveBeenCalled();
    });

    it("throws with the per-file accounting when a single-file upload fails", async () => {
        installSuccessfulSessionServer({
            storageUpload: async () => new Response(null, { status: 503 }),
        });

        const error = await uploadStandaloneDocument(
            new File(["pdf"], "failed.pdf"),
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(UploadBatchError);
        expect(error).toMatchObject({
            message: "The file could not be processed.",
            outcomes: [
                {
                    filename: "failed.pdf",
                    status: "error",
                    errorCode: "direct_upload_failed",
                },
            ],
        });
    });

    it("adds a session-uploaded document to a tabular review", async () => {
        installSuccessfulSessionServer();
        const uploaded = await uploadReviewDocument(
            "review-1",
            new File(["pdf"], "contract.pdf", { type: "application/pdf" }),
            {
                projectId: "project-1",
                documentIds: ["existing-document"],
                columnsConfig: [
                    { index: 0, name: "Term", prompt: "Find the term" },
                ],
            },
        );

        expect(uploaded).toEqual({ id: "result-contract.pdf" });
        const patchCall = fetchMock.mock.calls.find(
            ([url, init]) =>
                String(url) === `${API_URL}/tabular-review/review-1` &&
                (init as RequestInit).method === "PATCH",
        );
        expect(
            JSON.parse(String((patchCall?.[1] as RequestInit).body)),
        ).toMatchObject({
            document_ids: ["existing-document", "result-contract.pdf"],
        });
    });

    it("adds a standalone session upload to a new tabular review", async () => {
        installSuccessfulSessionServer();

        const uploaded = await uploadReviewDocument(
            "review-1",
            new File(["pdf"], "standalone.pdf", {
                type: "application/pdf",
            }),
        );

        expect(uploaded).toEqual({ id: "result-standalone.pdf" });
        const patchCall = fetchMock.mock.calls.find(
            ([url, init]) =>
                String(url) === `${API_URL}/tabular-review/review-1` &&
                (init as RequestInit).method === "PATCH",
        );
        expect(
            JSON.parse(String((patchCall?.[1] as RequestInit).body)),
        ).toMatchObject({ document_ids: ["result-standalone.pdf"] });
    });

    it.each([
        {
            name: "new document version",
            run: (file: File) =>
                uploadDocumentVersion("document-1", file, "renamed.pdf"),
            purpose: "document_version_create",
            destination: { document_id: "document-1", filename: "renamed.pdf" },
        },
        {
            name: "replacement document version",
            run: (file: File) =>
                replaceDocumentVersionFile("document-1", "version-1", file),
            purpose: "document_version_replace",
            destination: { document_id: "document-1", version_id: "version-1" },
        },
        {
            name: "workflow reference",
            run: (file: File) =>
                uploadWorkflowReferenceFile("workflow-1", file),
            purpose: "workflow_reference_create",
            destination: { workflow_id: "workflow-1" },
        },
        {
            name: "replacement workflow reference",
            run: (file: File) =>
                replaceWorkflowReferenceFile("workflow-1", "reference-1", file),
            purpose: "workflow_reference_replace",
            destination: {
                workflow_id: "workflow-1",
                reference_id: "reference-1",
            },
        },
    ])(
        "uses an upload session for $name",
        async ({ run, purpose, destination }) => {
            const server = installSuccessfulSessionServer();
            await run(
                new File(["pdf"], "contract.pdf", { type: "application/pdf" }),
            );
            expect(server.manifests[0]).toMatchObject({ purpose, destination });
        },
    );

    it("reports per-file failures without session-wide completion", async () => {
        const manifests: Manifest[] = [];
        fetchMock.mockImplementation(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (
                    url === `${API_URL}/upload-sessions` &&
                    init?.method === "POST"
                ) {
                    const manifest = JSON.parse(String(init.body)) as Manifest;
                    manifests.push(manifest);
                    const file = manifest.files[0];
                    return json(
                        {
                            session: {
                                id: "session-1",
                                status: "pending_upload",
                                expires_at: "2099-01-01T00:00:00Z",
                            },
                            files: [
                                {
                                    client_id: file.client_id,
                                    filename: file.filename,
                                    status: "pending_upload",
                                    error_code: null,
                                    result: null,
                                    upload: {
                                        method: "PUT",
                                        url: `https://storage.test/${file.client_id}`,
                                        headers: {},
                                    },
                                },
                            ],
                        },
                        201,
                    );
                }
                if (url === `${API_URL}/upload-sessions/session-1/urls`) {
                    const file = manifests[0].files[0];
                    return json({
                        files: [
                            {
                                client_id: file.client_id,
                                filename: file.filename,
                                status: "pending_upload",
                                error_code: null,
                                result: null,
                                upload: {
                                    method: "PUT",
                                    url: `https://storage.test/${file.client_id}`,
                                    headers: {},
                                },
                            },
                        ],
                    });
                }
                if (url.startsWith("https://storage.test/")) {
                    return new Response(null, { status: 503 });
                }
                if (
                    url.includes(
                        `${API_URL}/upload-sessions/session-1/files/`,
                    ) &&
                    url.endsWith("/complete") &&
                    init?.method === "POST"
                ) {
                    const file = manifests[0].files[0];
                    expect(JSON.parse(String(init.body))).toEqual({
                        failed: true,
                    });
                    return json({
                        session: {
                            id: "session-1",
                            status: "error",
                            error_code: "all_uploads_failed",
                            expires_at: "2099-01-01T00:00:00Z",
                        },
                        files: [
                            {
                                client_id: file.client_id,
                                filename: file.filename,
                                status: "error",
                                error_code: "direct_upload_failed",
                                result: null,
                            },
                        ],
                    });
                }
                if (
                    url === `${API_URL}/upload-sessions/session-1` &&
                    !init?.method
                ) {
                    const file = manifests[0].files[0];
                    return json({
                        session: {
                            id: "session-1",
                            status: "error",
                            error_code: "all_uploads_failed",
                        },
                        files: [
                            {
                                client_id: file.client_id,
                                filename: file.filename,
                                status: "error",
                                error_code: "direct_upload_failed",
                                result: null,
                            },
                        ],
                    });
                }
                if (
                    url === `${API_URL}/upload-sessions/session-1` &&
                    init?.method === "DELETE"
                ) {
                    return new Response(null, { status: 204 });
                }
                throw new Error(
                    `Unexpected request: ${init?.method ?? "GET"} ${url}`,
                );
            },
        );

        const outcomes = await uploadFilesWithSession({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [{ file: new File(["pdf"], "contract.pdf") }],
        });

        expect(outcomes).toMatchObject([
            { filename: "contract.pdf", errorCode: "direct_upload_failed" },
        ]);
        expect(fetchMock).not.toHaveBeenCalledWith(
            `${API_URL}/upload-sessions/session-1`,
            expect.objectContaining({ method: "DELETE" }),
        );
    });
});

describe("upload session polling", () => {
    it("backs off status checks and caps the interval at five seconds", () => {
        expect(
            Array.from({ length: 9 }, (_, index) =>
                uploadProcessingPollDelayMs(index),
            ),
        ).toEqual([
            750, 1_000, 1_500, 2_500, 4_000, 5_000, 5_000, 5_000, 5_000,
        ]);
    });

    it("continues polling after a rate-limit response", async () => {
        vi.useFakeTimers();
        try {
            const server = installSuccessfulSessionServer({
                statusPollFailures: 1,
                processingPollsBeforeComplete: 1,
            });
            const upload = uploadFilesWithSession({
                purpose: "document_create",
                destination: { scope: "standalone" },
                files: [{ file: new File(["pdf"], "contract.pdf") }],
            });

            await vi.runAllTimersAsync();

            await expect(upload).resolves.toMatchObject([
                { filename: "contract.pdf", status: "completed" },
            ]);
            expect(server.statusRequestCount()).toBe(3);
        } finally {
            vi.useRealTimers();
        }
    });
});
