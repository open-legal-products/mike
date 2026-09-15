// Coverage for the kinds added after the export work: the proactive MCP
// OAuth refresh and the legacy Office text precompute. Kept in its own
// file so the export handlers' mock
// surface (which stubs storage wholesale) stays untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";

type TokenRow = {
    connector_id: string;
    encrypted_access_token: string | null;
    encrypted_refresh_token: string | null;
    expires_at: string | null;
};
const loadOAuthToken = vi.fn(
    async (..._a: unknown[]) => null as TokenRow | null,
);
const refreshOAuthAccessToken = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock("../../mcp/oauth", async (importOriginal) => {
    // importOriginal keeps McpOAuthRequiredError the REAL class, so the
    // handler's `instanceof` check is exercised rather than faked.
    const actual = await importOriginal<typeof import("../../mcp/oauth")>();
    return {
        ...actual,
        loadOAuthToken: (...a: unknown[]) => loadOAuthToken(...a),
        refreshOAuthAccessToken: (...a: unknown[]) =>
            refreshOAuthAccessToken(...a),
    };
});

const extractLegacyOfficeText = vi.fn(
    async (..._a: unknown[]) => "[Page 1]\nhello from libreoffice",
);
vi.mock("../../pdfText", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../pdfText")>();
    return {
        ...actual,
        extractLegacyOfficeText: (...a: unknown[]) =>
            extractLegacyOfficeText(...a),
    };
});

const uploadFile = vi.fn(async (..._a: unknown[]) => {});
const downloadFile = vi.fn(
    async (..._a: unknown[]) =>
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer as ArrayBuffer | null,
);
vi.mock("../../storage", async (importOriginal) => {
    // extractedTextKey stays REAL: the point of the precompute test is that
    // the handler writes the key the read path will look for.
    const actual = await importOriginal<typeof import("../../storage")>();
    return {
        ...actual,
        uploadFile: (...a: unknown[]) => uploadFile(...a),
        downloadFile: (...a: unknown[]) => downloadFile(...a),
    };
});

import { McpOAuthRequiredError } from "../../mcp/oauth";
import {
    handleMcpRefreshToken,
    handleDocumentPrecomputeText,
    MCP_TOKEN_REFRESH_WINDOW_MS,
    DB_JOB_HANDLERS,
} from "../../../jobs/registry";
import type { DbJob } from "../types";

const JOB = (kind: string, payload: Record<string, unknown>): DbJob => ({
    id: "job-1",
    kind,
    payload,
    status: "running",
    attempts: 1,
    max_attempts: 3,
    run_at: "",
    claimed_at: null,
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "",
});

const DB = { from: () => {
    const query = { select: () => query, eq: () => query, is: () => query,
        maybeSingle: async () => ({ data: { id: "v-123" }, error: null }) };
    return query;
} } as never;

const tokenRow = (overrides: Partial<TokenRow> = {}): TokenRow => ({
    connector_id: "c1",
    encrypted_access_token: "enc-access",
    encrypted_refresh_token: "enc-refresh",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
});

beforeEach(() => {
    loadOAuthToken.mockReset().mockResolvedValue(null);
    refreshOAuthAccessToken.mockReset().mockResolvedValue({});
    extractLegacyOfficeText
        .mockReset()
        .mockResolvedValue("[Page 1]\nhello from libreoffice");
    uploadFile.mockReset().mockResolvedValue(undefined);
    downloadFile
        .mockReset()
        .mockResolvedValue(
            new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer as ArrayBuffer,
        );
});

describe("registry", () => {
    it("registers every new kind", () => {
        expect(Object.keys(DB_JOB_HANDLERS)).toEqual(
            expect.arrayContaining([
                "mcp.refresh_token",
                "document.precompute_text",
            ]),
        );
    });
});

describe("handleMcpRefreshToken", () => {
    it("no-ops on a token that is not near expiry (idempotent re-run)", async () => {
        loadOAuthToken.mockResolvedValue(
            tokenRow({
                expires_at: new Date(
                    Date.now() + MCP_TOKEN_REFRESH_WINDOW_MS + 60_000,
                ).toISOString(),
            }),
        );
        await handleMcpRefreshToken(
            DB,
            JOB("mcp.refresh_token", { connectorId: "c1" }),
        );
        expect(refreshOAuthAccessToken).not.toHaveBeenCalled();
    });

    it("refreshes a token inside the expiry window", async () => {
        loadOAuthToken.mockResolvedValue(tokenRow());
        await handleMcpRefreshToken(
            DB,
            JOB("mcp.refresh_token", { connectorId: "c1" }),
        );
        expect(refreshOAuthAccessToken).toHaveBeenCalledTimes(1);
    });

    it("rethrows a TRANSIENT refresh failure so the queue retries", async () => {
        loadOAuthToken.mockResolvedValue(tokenRow());
        refreshOAuthAccessToken.mockRejectedValue(
            new McpOAuthRequiredError("OAuth token refresh failed.", {
                permanent: false,
            }),
        );
        await expect(
            handleMcpRefreshToken(
                DB,
                JOB("mcp.refresh_token", { connectorId: "c1" }),
            ),
        ).rejects.toThrow(/refresh failed/);
    });

    it("rethrows a non-OAuth (network) failure so the queue retries", async () => {
        loadOAuthToken.mockResolvedValue(tokenRow());
        refreshOAuthAccessToken.mockRejectedValue(new Error("ECONNRESET"));
        await expect(
            handleMcpRefreshToken(
                DB,
                JOB("mcp.refresh_token", { connectorId: "c1" }),
            ),
        ).rejects.toThrow(/ECONNRESET/);
    });

    it("swallows invalid_grant — retrying a dead grant is pointless", async () => {
        loadOAuthToken.mockResolvedValue(tokenRow());
        refreshOAuthAccessToken.mockRejectedValue(
            new McpOAuthRequiredError("OAuth token refresh failed.", {
                permanent: true,
                oauthErrorCode: "invalid_grant",
            }),
        );
        await expect(
            handleMcpRefreshToken(
                DB,
                JOB("mcp.refresh_token", { connectorId: "c1" }),
            ),
        ).resolves.toBeUndefined();
    });

    it("ignores a connector with no token row or no refresh token", async () => {
        for (const row of [
            null,
            tokenRow({ encrypted_refresh_token: null }),
            tokenRow({ encrypted_access_token: null }),
        ]) {
            loadOAuthToken.mockResolvedValue(row);
            await handleMcpRefreshToken(
                DB,
                JOB("mcp.refresh_token", { connectorId: "c1" }),
            );
        }
        expect(refreshOAuthAccessToken).not.toHaveBeenCalled();
    });

    it("ignores a malformed payload instead of retrying it forever", async () => {
        await handleMcpRefreshToken(DB, JOB("mcp.refresh_token", {}));
        expect(loadOAuthToken).not.toHaveBeenCalled();
    });
});

describe("handleDocumentPrecomputeText", () => {
    it("uploads the extracted text to extracted-text/<versionId>.txt", async () => {
        await handleDocumentPrecomputeText(
            DB,
            JOB("document.precompute_text", {
                versionId: "v-123",
                storagePath: "documents/u1/d1/brief.doc",
                fileType: "doc",
            }),
        );
        expect(downloadFile).toHaveBeenCalledWith("documents/u1/d1/brief.doc");
        const [key, body, contentType] = uploadFile.mock.calls[0] as [
            string,
            ArrayBuffer,
            string,
        ];
        expect(key).toBe("extracted-text/v-123.txt");
        expect(contentType).toBe("text/plain; charset=utf-8");
        expect(Buffer.from(body).toString("utf8")).toBe(
            "[Page 1]\nhello from libreoffice",
        );
    });

    it("throws when the source bytes are gone so the job retries", async () => {
        downloadFile.mockResolvedValue(null);
        await expect(
            handleDocumentPrecomputeText(
                DB,
                JOB("document.precompute_text", {
                    versionId: "v-123",
                    storagePath: "documents/u1/d1/brief.doc",
                    fileType: "ppt",
                }),
            ),
        ).rejects.toThrow(/source unavailable/);
        expect(uploadFile).not.toHaveBeenCalled();
    });

    it("refuses types that already have an in-process reader", async () => {
        for (const fileType of ["docx", "pptx", "xlsx", "pdf", undefined]) {
            await handleDocumentPrecomputeText(
                DB,
                JOB("document.precompute_text", {
                    versionId: "v-123",
                    storagePath: "documents/u1/d1/brief.docx",
                    fileType,
                }),
            );
        }
        expect(extractLegacyOfficeText).not.toHaveBeenCalled();
        expect(uploadFile).not.toHaveBeenCalled();
    });
});
