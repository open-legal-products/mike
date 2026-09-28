import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    completeGoogleDriveOAuth,
    cancelGoogleDriveOAuth,
    disconnectGoogleDrive,
    executeGoogleDriveToolCall,
    getGoogleDriveStatus,
    startGoogleDriveOAuth,
    GOOGLE_DRIVE_SCOPE,
} from "../googleDrive";
import { decryptString } from "../../mcp/client";
import { driveDb } from "./googleDriveDb";

beforeEach(() => {
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "test-secret");
    vi.stubEnv("MCP_CONNECTORS_ENCRYPTION_SECRET", "test-encryption-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
const tokens = {
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    scope: GOOGLE_DRIVE_SCOPE,
    expires_in: 3600,
};
const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status });
async function begin(store: ReturnType<typeof driveDb>, user = "u1") {
    const result = await startGoogleDriveOAuth(
        user,
        "https://mike.test/api/callback",
        store.db,
    );
    return new URL(result.authorizationUrl).searchParams.get("state")!;
}
async function connected() {
    const store = driveDb();
    const state = await begin(store);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => json(tokens)),
    );
    await completeGoogleDriveOAuth("u1", state, "code", store.db);
    return store;
}

describe("Google Drive OAuth lifecycle", () => {
    it("does not mix credentials from incomplete dedicated and fallback clients", async () => {
        vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "");
        vi.stubEnv("GOOGLE_MCP_OAUTH_CLIENT_SECRET", "other-client-secret");
        const store = driveDb();
        expect((await getGoogleDriveStatus("u1", store.db)).configured).toBe(
            false,
        );
        await expect(begin(store)).rejects.toThrow(/needs an OAuth client/);
    });
    it("exchanges the caller-bound state with PKCE and stores only encrypted tokens", async () => {
        const store = driveDb();
        const state = await begin(store);
        expect(JSON.stringify(store.states)).not.toContain(state);
        const config = JSON.parse(
            decryptString(
                String(store.states[0].encrypted_state_config),
                String(store.states[0].state_config_iv),
                String(store.states[0].state_config_tag),
            )!,
        );
        const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
            const body = init?.body as URLSearchParams;
            expect(body.get("code_verifier")).toBe(config.codeVerifier);
            expect(body.get("redirect_uri")).toBe(
                "https://mike.test/api/callback",
            );
            expect(body.get("client_secret")).toBe("test-secret");
            return json(tokens);
        });
        vi.stubGlobal("fetch", fetchMock);
        expect(
            await completeGoogleDriveOAuth("u1", state, "code", store.db),
        ).toEqual({ userId: "u1" });
        expect(store.states).toHaveLength(0);
        const row = store.tokens[0];
        expect(row.user_id).toBe("u1");
        expect(JSON.stringify(row)).not.toContain("access-secret");
        expect(JSON.stringify(row)).not.toContain("refresh-secret");
        expect(
            decryptString(
                String(row.encrypted_refresh_token),
                String(row.refresh_token_iv),
                String(row.refresh_token_tag),
            ),
        ).toBe("refresh-secret");
        await expect(
            completeGoogleDriveOAuth("u1", state, "code", store.db),
        ).rejects.toThrow(/invalid or expired/);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect((await getGoogleDriveStatus("u2", store.db)).connected).toBe(
            false,
        );
    });
    it("rejects another Mike user's authorization URL before token exchange", async () => {
        const store = driveDb();
        const state = await begin(store, "attacker");
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(
            completeGoogleDriveOAuth("victim", state, "code", store.db),
        ).rejects.toThrow(/invalid or expired/);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.tokens).toHaveLength(0);
        expect(store.states).toHaveLength(1);
    });
    it("rejects expired state before contacting Google", async () => {
        const store = driveDb();
        const state = await begin(store);
        store.states[0].expires_at = "2000-01-01T00:00:00Z";
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);
        await expect(
            completeGoogleDriveOAuth("u1", state, "code", store.db),
        ).rejects.toThrow(/invalid or expired/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each([
        { ...tokens, refresh_token: undefined },
        { ...tokens, scope: "openid" },
        { ...tokens, expires_in: -1 },
    ])(
        "does not mark incomplete/invalid grants as connected",
        async (token) => {
            const store = driveDb();
            const state = await begin(store);
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => json(token)),
            );
            await expect(
                completeGoogleDriveOAuth("u1", state, "code", store.db),
            ).rejects.toThrow();
            expect(store.tokens).toHaveLength(0);
        },
    );
    it("does not persist a failed token exchange", async () => {
        const store = driveDb();
        const state = await begin(store);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => json({ error: "invalid_grant" }, 400)),
        );
        await expect(
            completeGoogleDriveOAuth("u1", state, "code", store.db),
        ).rejects.toThrow();
        expect(store.tokens).toHaveLength(0);
    });
    it("reports database write failures without claiming completion", async () => {
        const store = driveDb();
        const state = await begin(store);
        store.failures.set(
            "complete_google_drive_oauth",
            new Error("internal sentinel"),
        );
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => json(tokens)),
        );
        await expect(
            completeGoogleDriveOAuth("u1", state, "code", store.db),
        ).rejects.toThrow("internal sentinel");
        expect(store.tokens).toHaveLength(0);
        expect(store.states).toHaveLength(1);
    });
    it("cancel is scoped to its caller and blocks an in-flight callback from saving", async () => {
        const store = driveDb();
        const state = await begin(store);
        await cancelGoogleDriveOAuth("u2", state, store.db);
        expect(store.states).toHaveLength(1);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                await cancelGoogleDriveOAuth("u1", state, store.db);
                return json(tokens);
            }),
        );
        await expect(
            completeGoogleDriveOAuth("u1", state, "code", store.db),
        ).rejects.toThrow(/cancelled/);
        expect(store.tokens).toHaveLength(0);
    });
    it("disconnect during code exchange prevents reconnection", async () => {
        const store = driveDb();
        const state = await begin(store);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                await disconnectGoogleDrive("u1", store.db);
                return json(tokens);
            }),
        );
        await expect(
            completeGoogleDriveOAuth("u1", state, "code", store.db),
        ).rejects.toThrow(/cancelled/);
        expect(store.tokens).toHaveLength(0);
    });
    it("refreshes expired access while preserving the refresh token", async () => {
        const store = await connected();
        const refreshCiphertext = store.tokens[0].encrypted_refresh_token;
        store.tokens[0].expires_at = "2000-01-01T00:00:00Z";
        const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
            if (String(input).includes("oauth2.googleapis.com/token")) {
                expect(
                    (init?.body as URLSearchParams).get("refresh_token"),
                ).toBe("refresh-secret");
                return json({ access_token: "new-access", expires_in: 3600 });
            }
            expect(
                (init?.headers as Record<string, string>).Authorization,
            ).toBe("Bearer new-access");
            return json({ files: [] });
        });
        vi.stubGlobal("fetch", fetchMock);
        const result = await executeGoogleDriveToolCall(
            "u1",
            "google_drive_list_recent",
            {},
            store.db,
        );
        expect(JSON.parse(result.content).ok).toBe(true);
        expect(store.tokens[0].encrypted_refresh_token).toBe(refreshCiphertext);
        expect(Date.parse(String(store.tokens[0].expires_at))).toBeGreaterThan(
            Date.now(),
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it("an in-flight refresh cannot resurrect a disconnected token", async () => {
        const store = await connected();
        store.tokens[0].expires_at = "2000-01-01T00:00:00Z";
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input) => {
                if (String(input).includes("/token")) {
                    await disconnectGoogleDrive("u1", store.db);
                    return json({
                        access_token: "new-access",
                        expires_in: 3600,
                    });
                }
                return new Response(null, { status: 200 });
            }),
        );
        const result = await executeGoogleDriveToolCall(
            "u1",
            "google_drive_list_recent",
            {},
            store.db,
        );
        expect(JSON.parse(result.content).ok).toBe(false);
        expect(store.tokens).toHaveLength(0);
    });
    it("disconnects only Drive without revoking the shared Google project grant", async () => {
        const store = await connected();
        await begin(store);
        await begin(store, "u2");
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("provider-secret");
            }),
        );
        await disconnectGoogleDrive("u1", store.db);
        expect(store.tokens).toHaveLength(0);
        expect(store.states.map((s) => s.user_id)).toEqual(["u2"]);
        expect(fetch).not.toHaveBeenCalled();
    });
    it("disconnect still works when ciphertext cannot be decrypted", async () => {
        const store = await connected();
        store.tokens[0].refresh_token_tag = "corrupt";
        await disconnectGoogleDrive("u1", store.db);
        expect(store.tokens).toHaveLength(0);
    });
    it("does not leak database/crypto/provider exceptions through events, tool content or logs", async () => {
        const store = driveDb();
        store.failures.set(
            "user_google_drive_tokens:select",
            new Error("secret-internal-sentinel"),
        );
        const result = await executeGoogleDriveToolCall(
            "u1",
            "google_drive_list_recent",
            {},
            store.db,
        );
        expect(JSON.stringify(result)).not.toContain(
            "secret-internal-sentinel",
        );
        expect(
            JSON.stringify(vi.mocked(console.error).mock.calls),
        ).not.toContain("secret-internal-sentinel");
        expect(result.event.error).toBe(
            "Google Drive call failed. Please try again.",
        );
    });
    it("reports missing OAuth state table as schema not ready", async () => {
        const store = driveDb();
        store.failures.set("google_drive_oauth_states:select", {
            code: "PGRST205",
        });
        expect((await getGoogleDriveStatus("u1", store.db)).schemaReady).toBe(
            false,
        );
    });
    it("labels partial Sheets content and truncates long exports", async () => {
        const store = await connected();
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input) =>
                String(input).includes("/export")
                    ? new Response("x".repeat(60_010))
                    : json({
                          id: "f1",
                          mimeType: "application/vnd.google-apps.spreadsheet",
                      }),
            ),
        );
        const result = await executeGoogleDriveToolCall(
            "u1",
            "google_drive_read_file",
            { file_id: "f1" },
            store.db,
        );
        const payload = JSON.parse(result.content);
        expect(payload.text).toHaveLength(60_000);
        expect(payload.truncated).toBe(true);
        expect(payload.limitation).toContain("Only the first worksheet");
    });
    it("rejects an oversized binary from metadata before downloading", async () => {
        const store = await connected();
        const fetchMock = vi.fn(async () =>
            json({ id: "f1", mimeType: "application/pdf", size: "104857601" }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const result = await executeGoogleDriveToolCall(
            "u1",
            "google_drive_read_file",
            { file_id: "f1" },
            store.db,
        );
        expect(result.event.error).toContain("100 MiB");
        expect(fetchMock).toHaveBeenCalledOnce();
    });
    it("sanitizes upstream API messages", async () => {
        const store = await connected();
        vi.stubGlobal(
            "fetch",
            vi.fn(async () =>
                json({ error: { message: "secret-upstream-sentinel" } }, 403),
            ),
        );
        const result = await executeGoogleDriveToolCall(
            "u1",
            "google_drive_list_recent",
            {},
            store.db,
        );
        expect(JSON.stringify(result)).not.toContain(
            "secret-upstream-sentinel",
        );
        expect(result.event.error).toMatch(/not permitted/);
    });
});
