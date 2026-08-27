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
    storageUpload?: (url: string) => Promise<Response>;
    fileCompletion?: (
        url: string,
        init: RequestInit,
    ) => Promise<Response> | Response;
    statusPollFailures?: number;
    processingPollsBeforeComplete?: number;
}) {
    const manifests: Manifest[] = [];
    const states = new Map<
        string,
        {
            status: "pending_upload" | "processing" | "completed" | "error";
            error_code: string | null;
        }
    >();
    let activeStorageUploads = 0;
    let maximumStorageUploads = 0;
    let statusRequestCount = 0;
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
                url: `https://storage.test/${file.client_id}`,
                headers: { "Content-Type": "application/pdf" },
            },
        }));
    const sessionResponse = (finishProcessing = false) => {
        const manifest = manifests.at(-1)!;
        if (finishProcessing) {
            for (const state of states.values()) {
                if (state.status === "processing") state.status = "completed";
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
                id: "session-1",
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
                for (const file of manifest.files) {
                    states.set(file.client_id, {
                        status: "pending_upload",
                        error_code: null,
                    });
                }
                return json(
                    {
                        session: {
                            id: "session-1",
                            status: "pending_upload",
                            expires_at: "2099-01-01T00:00:00Z",
                        },
                        files: uploadFiles(manifest),
                    },
                    201,
                );
            }
            if (
                url === `${API_URL}/upload-sessions/session-1/urls` &&
                init?.method === "POST"
            ) {
                return json({ files: uploadFiles(manifests.at(-1)!) });
            }
            if (url.startsWith("https://storage.test/")) {
                activeStorageUploads += 1;
                maximumStorageUploads = Math.max(
                    maximumStorageUploads,
                    activeStorageUploads,
                );
                try {
                    return options?.storageUpload
                        ? await options.storageUpload(url)
                        : new Response(null, { status: 200 });
                } finally {
                    activeStorageUploads -= 1;
                }
            }
            const fileCompletion = url.match(
                new RegExp(
                    `^${API_URL}/upload-sessions/session-1/files/([^/]+)/complete$`,
                ),
            );
            if (fileCompletion && init?.method === "POST") {
                if (options?.fileCompletion) {
                    return await options.fileCompletion(url, init);
                }
                const completedClientId = decodeURIComponent(
                    fileCompletion[1]!,
                );
                const failed = JSON.parse(String(init.body ?? "{}")) as {
                    failed?: boolean;
                };
                states.set(completedClientId, {
                    status: failed.failed ? "error" : "processing",
                    error_code: failed.failed ? "direct_upload_failed" : null,
                });
                return json(sessionResponse());
            }
            if (
                url === `${API_URL}/upload-sessions/session-1` &&
                !init?.method
            ) {
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
                const completedPolls = statusRequestCount - failedPolls;
                return json(
                    sessionResponse(
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
        maximumStorageUploads: () => maximumStorageUploads,
        statusRequestCount: () => statusRequestCount,
    };
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

    it("surfaces unconfirmed per-file completion without bulk completion or cancellation", async () => {
        let completionAttempts = 0;
        installSuccessfulSessionServer({
            fileCompletion: () => {
                completionAttempts += 1;
                return json(
                    { code: "temporary_failure", detail: "Try again" },
                    503,
                );
            },
        });

        const error = await uploadFilesWithSession({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: [{ file: new File(["pdf"], "contract.pdf") }],
        }).catch((caught: unknown) => caught);

        expect(completionAttempts).toBe(3);
        expect(error).toBeInstanceOf(UploadBatchError);
        expect(error).toMatchObject({
            outcomes: [
                expect.objectContaining({
                    filename: "contract.pdf",
                    errorCode: "upload_confirmation_failed",
                }),
            ],
        });
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

    it("rejects a 51-file batch before reserving a backend session", async () => {
        const error = await uploadFilesWithSession({
            purpose: "document_create",
            destination: { scope: "standalone" },
            files: Array.from({ length: 51 }, (_, index) => ({
                file: new File(["pdf"], `contract-${index}.pdf`),
            })),
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(UploadBatchError);
        expect(error).toMatchObject({
            message: "You can upload at most 50 files at a time.",
            outcomes: expect.arrayContaining([
                expect.objectContaining({ errorCode: "too_many_files" }),
            ]),
        });
        expect(fetchMock).not.toHaveBeenCalled();
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

    it("throws when a single-file convenience upload does not complete", async () => {
        installSuccessfulSessionServer({
            storageUpload: async () => new Response(null, { status: 503 }),
        });

        await expect(
            uploadStandaloneDocument(new File(["pdf"], "failed.pdf")),
        ).rejects.toThrow("The file could not be processed.");
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
