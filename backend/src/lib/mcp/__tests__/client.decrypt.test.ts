import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(() => null) }));
vi.mock("../../observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reportError,
}));

import { decryptAuthConfig, decryptString, encryptString } from "../client";
import type { ConnectorRow } from "../types";

const SECRET_VAR = "MCP_CONNECTORS_ENCRYPTION_SECRET";
let previousSecret: string | undefined;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    previousSecret = process.env[SECRET_VAR];
    process.env[SECRET_VAR] = "test-secret-for-connector-decryption";
    reportError.mockClear();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
    if (previousSecret === undefined) delete process.env[SECRET_VAR];
    else process.env[SECRET_VAR] = previousSecret;
    errorSpy.mockRestore();
});

// A secret that no longer decrypts (rotated key, corrupt row) only ever
// surfaced as "the connector stopped working". It is now reported under its
// kind, with the cipher's error as the cause; the message stays in the log.
describe("connector secret decryption failures", () => {
    it("round-trips an intact secret without reporting", () => {
        const { encrypted, iv, tag } = encryptString("token-123");
        expect(decryptString(encrypted, iv, tag)).toBe("token-123");
        expect(reportError).not.toHaveBeenCalled();
    });

    it("reports a secret that fails to decrypt under mcp.decrypt_failed and returns null", () => {
        const { encrypted, iv } = encryptString("token-123");
        const badTag = Buffer.alloc(16, 1).toString("base64");

        expect(decryptString(encrypted, iv, badTag)).toBeNull();

        expect(reportError).toHaveBeenCalledTimes(1);
        const [reported] = reportError.mock.calls[0] as unknown as [{ kind: string; cause: unknown }];
        expect(reported.kind).toBe("mcp.decrypt_failed");
        expect(reported.cause).toBeInstanceOf(Error);
        expect(errorSpy).toHaveBeenCalledWith(
            "[mcp-connectors] failed to decrypt string secret",
            { error: reported },
        );
    });

    it("reports an auth config that fails to decrypt and falls back to an empty config", () => {
        const { encrypted, iv } = encryptString(JSON.stringify({ token: "t" }));
        const row = {
            id: "connector-1",
            encrypted_auth_config: encrypted,
            auth_config_iv: iv,
            auth_config_tag: Buffer.alloc(16, 2).toString("base64"),
        } as unknown as ConnectorRow;

        expect(decryptAuthConfig(row)).toEqual({});

        expect(reportError).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "mcp.decrypt_failed" }),
        );
        expect(errorSpy).toHaveBeenCalledWith(
            "[mcp-connectors] failed to decrypt auth config",
            expect.objectContaining({ connectorId: "connector-1" }),
        );
    });
});
