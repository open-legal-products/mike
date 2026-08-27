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
    uploadProjectDocuments,
    uploadReviewDocument,
    uploadWorkflowReferenceFile,
} from "./mikeApi";

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
}) {
    const manifests: Manifest[] = [];
    let activeStorageUploads = 0;
    let maximumStorageUploads = 0;
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

    fetchMock.mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (
                url === `${API_URL}/upload-sessions` &&
                init?.method === "POST"
            ) {
                const manifest = JSON.parse(String(init.body)) as Manifest;
                manifests.push(manifest);
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
                const completedClientId = decodeURIComponent(
                    fileCompletion[1]!,
                );
                const manifest = manifests.at(-1)!;
                return json({
                    session: {
                        id: "session-1",
                        status: "pending_upload",
                        expires_at: "2099-01-01T00:00:00Z",
                    },
                    files: uploadFiles(manifest).map((file) => ({
                        ...file,
                        status:
                            file.client_id === completedClientId
                                ? "processing"
                                : "pending_upload",
                        upload: undefined,
                    })),
                });
            }
            if (url === `${API_URL}/upload-sessions/session-1/complete`) {
                const manifest = manifests.at(-1)!;
                const failedClientIds = new Set(
                    JSON.parse(String(init?.body ?? "{}"))
                        .failed_client_ids as string[] | undefined,
                );
                const hasSuccess = manifest.files.some(
                    (file) => !failedClientIds.has(file.client_id),
                );
                return json({
                    session: {
                        id: "session-1",
                        status: hasSuccess ? "completed" : "error",
                        expires_at: "2099-01-01T00:00:00Z",
                    },
                    files: manifest.files.map((file) => ({
                        client_id: file.client_id,
                        filename: file.filename,
                        status: failedClientIds.has(file.client_id)
                            ? "error"
                            : "completed",
                        error_code: failedClientIds.has(file.client_id)
                            ? "direct_upload_failed"
                            : null,
                        result: failedClientIds.has(file.client_id)
                            ? null
                            : { id: `result-${file.filename}` },
                    })),
                });
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
        const batchCompletion = calls.findIndex((url) =>
            url.endsWith("/session-1/complete"),
        );
        expect(firstFileCompletion).toBeGreaterThan(-1);
        expect(firstFileCompletion).toBeLessThan(batchCompletion);
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

        expect(outcomes.filter((outcome) => outcome.status === "completed")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "error")).toMatchObject([
            { errorCode: "direct_upload_failed" },
        ]);
        expect(attempts.get(failedUrl!)).toBe(3);
        expect(failedUploadMessage(outcomes)).toBe(
            "a.pdf could not be uploaded. Please try again.",
        );
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

    it("finalizes per-file failures without cancelling the whole session", async () => {
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
                    url === `${API_URL}/upload-sessions/session-1/complete` &&
                    init?.method === "POST"
                ) {
                    const file = manifests[0].files[0];
                    expect(JSON.parse(String(init.body))).toEqual({
                        failed_client_ids: [file.client_id],
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
