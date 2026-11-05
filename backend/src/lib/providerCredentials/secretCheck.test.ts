import { beforeEach, describe, expect, it, vi } from "vitest";

const reportError = vi.hoisted(() => vi.fn());
vi.mock("../observability/sentry", () => ({ reportError }));

import { findAppError } from "../appError";
import { reportMissingEncryptionSecret } from "./secretCheck";

function fakeDb(rowsByTable: Record<string, unknown[] | Error>) {
  const queried: string[] = [];
  const db = {
    from(table: string) {
      queried.push(table);
      const result = rowsByTable[table] ?? [];
      const chain = {
        select: () => chain,
        not: () => chain,
        limit: async () =>
          result instanceof Error
            ? { data: null, error: { message: result.message } }
            : { data: result, error: null },
      };
      return chain;
    },
  };
  return { db: () => db as never, queried };
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

  it("stays silent when the tables cannot be read", async () => {
    const { db } = fakeDb({
      user_api_keys: new Error("relation does not exist"),
      org_api_keys: new Error("relation does not exist"),
      user_courtlistener_connections: new Error("relation does not exist"),
    });
    await expect(reportMissingEncryptionSecret({}, db)).resolves.toBe("unknown");
    expect(reportError).not.toHaveBeenCalled();
  });
});
