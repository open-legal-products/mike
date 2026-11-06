import { beforeEach, describe, expect, it, vi } from "vitest";

const reportError = vi.hoisted(() => vi.fn());
vi.mock("../observability/sentry", () => ({ reportError }));

import { findAppError } from "../appError";
import { columnsUsingKeySecret, reportMissingEncryptionSecret } from "./secretCheck";

function fakeDb(rowsByTable: Record<string, unknown[] | Error>) {
  const queried: string[] = [];
  const columns: string[] = [];
  const db = {
    from(table: string) {
      queried.push(table);
      const result = rowsByTable[table] ?? [];
      const chain = {
        select: () => chain,
        not: (column: string) => {
          columns.push(`${table}.${column}`);
          return chain;
        },
        limit: async () =>
          result instanceof Error
            ? { data: null, error: { message: result.message } }
            : { data: result, error: null },
      };
      return chain;
    },
  };
  return { db: () => db as never, queried, columns };
}

describe("reportMissingEncryptionSecret", () => {
  beforeEach(() => {
    reportError.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("reports a missing secret once, as a configuration error, when stored keys exist", async () => {
    const { db } = fakeDb({ org_api_keys: [{ id: "k" }] });

    await expect(reportMissingEncryptionSecret({}, db)).resolves.toBe("missing");

    expect(reportError).toHaveBeenCalledTimes(1);
    const [error, context] = reportError.mock.calls[0]!;
    expect(findAppError(error)?.kind).toBe("config.encryption_secret_missing");
    expect(error).toMatchObject({
      code: "configuration_invalid",
      configurationFields: ["USER_API_KEYS_ENCRYPTION_SECRET"],
    });
    expect(context).toMatchObject({
      level: "error",
      tags: { component: "boot", stage: "encryption-secret" },
    });
  });

  it("says nothing when no key was ever stored", async () => {
    const { db } = fakeDb({});
    await expect(reportMissingEncryptionSecret({}, db)).resolves.toBe("no_stored_keys");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not query the database when the secret is configured", async () => {
    const { db, queried } = fakeDb({ user_api_keys: [{ id: "k" }] });
    await expect(
      reportMissingEncryptionSecret({ USER_API_KEYS_ENCRYPTION_SECRET: "s" }, db),
    ).resolves.toBe("configured");
    expect(queried).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  // lib/mcp/client.ts encrypts with MCP_CONNECTORS_ENCRYPTION_SECRET ||
  // USER_API_KEYS_ENCRYPTION_SECRET, so connector rows depend on it too.
  it("reports connector credentials that fall back to the same secret", async () => {
    const { db, columns } = fakeDb({ user_mcp_connectors: [{ id: "c" }] });
    await expect(reportMissingEncryptionSecret({}, db)).resolves.toBe("missing");
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(columns).toContain("user_mcp_connectors.encrypted_auth_config");
    expect(columnsUsingKeySecret({}).map((c) => `${c.table}.${c.column}`)).toEqual(
      expect.arrayContaining([
        "user_mcp_oauth_tokens.encrypted_access_token",
        "user_google_drive_tokens.encrypted_access_token",
        "user_google_workspace_tokens.encrypted_access_token",
      ]),
    );
  });

  it("leaves connector rows out when they have their own secret", async () => {
    const { db, queried } = fakeDb({ user_mcp_connectors: [{ id: "c" }] });
    await expect(
      reportMissingEncryptionSecret({ MCP_CONNECTORS_ENCRYPTION_SECRET: "m" }, db),
    ).resolves.toBe("no_stored_keys");
    expect(queried).not.toContain("user_mcp_connectors");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("stays silent when the tables cannot be read", async () => {
    const missing = new Error("relation does not exist");
    const { db } = fakeDb({
      user_api_keys: missing,
      org_api_keys: missing,
      user_courtlistener_connections: missing,
      user_mcp_connectors: missing,
      user_mcp_oauth_tokens: missing,
      user_google_drive_tokens: missing,
      user_google_workspace_tokens: missing,
    });
    await expect(reportMissingEncryptionSecret({}, db)).resolves.toBe("unknown");
    expect(reportError).not.toHaveBeenCalled();
  });
});
