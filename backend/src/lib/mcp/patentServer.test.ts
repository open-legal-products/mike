import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
    isManagedPatentConnector,
    isManagedPatentToolPolicy,
    isUsptoConnectorEnabled,
    PATENT_MCP_ENV_ALLOWLIST_KEYS,
    PATENT_MCP_PACKAGE,
    PATENT_MCP_PYTHON,
    PATENT_MCP_SDK,
    PATENT_MCP_SERVER_URI,
    patentManagedToolPolicy,
    patentMcpEnvironment,
    patentMcpFailureDetail,
    patentMcpLaunchSpec,
    PatentRuntimeUnavailableError,
    withPatentProcessSlot,
} from "./patentServer";
import type { ConnectorRow, Db } from "./types";

const ENV_KEYS = [
    "PATENT_MCP_EXECUTABLE",
    "PATENT_MCP_DIRECTORY",
    "PATENT_MCP_UV_DATA_DIR",
    "PATENT_MCP_MAX_CONCURRENT",
    "PATENT_MCP_MAX_QUEUE",
    "PATENT_MCP_QUEUE_TIMEOUT_MS",
    "USPTO_API_KEY",
    "TSDR_API_KEY",
    "TMSEARCH_WAF_TOKEN",
    "SUPABASE_SECRET_KEY",
    "ANTHROPIC_API_KEY",
];

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
    for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        const value = savedEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    savedEnv.clear();
});

describe("patentMcpLaunchSpec", () => {
    it("runs the pinned package through uvx by default", () => {
        const spec = patentMcpLaunchSpec();
        expect(spec.command).toBe("uvx");
        expect(spec.args).toEqual([
            "--python",
            PATENT_MCP_PYTHON,
            "--from",
            PATENT_MCP_PACKAGE,
            "--with",
            PATENT_MCP_SDK,
            "patent-mcp-server",
        ]);
    });

    it("runs the bare preinstalled entrypoint when configured", () => {
        process.env.PATENT_MCP_EXECUTABLE = "patent-mcp-server";
        expect(patentMcpLaunchSpec()).toEqual({
            command: "patent-mcp-server",
            args: [],
        });
    });

    it("rejects a PATENT_MCP_EXECUTABLE with path or shell syntax", () => {
        process.env.PATENT_MCP_EXECUTABLE = "/tmp/evil; rm -rf /";
        expect(() => patentMcpLaunchSpec()).toThrow(
            PatentRuntimeUnavailableError,
        );
    });

    it("runs an upstream checkout through uv when PATENT_MCP_DIRECTORY is set", () => {
        process.env.PATENT_MCP_DIRECTORY = "/opt/patent_mcp_server";
        const spec = patentMcpLaunchSpec();
        expect(spec.command).toBe("uv");
        expect(spec.args).toEqual([
            "--directory",
            "/opt/patent_mcp_server",
            "run",
            "--python",
            PATENT_MCP_PYTHON,
            "--with",
            PATENT_MCP_SDK,
            "patent-mcp-server",
        ]);
    });
});

describe("patentMcpEnvironment", () => {
    it("passes allowlisted USPTO credentials but never Mike secrets", () => {
        process.env.USPTO_API_KEY = "  uspto-key  ";
        process.env.TMSEARCH_WAF_TOKEN = "waf-token";
        process.env.SUPABASE_SECRET_KEY = "db-secret";
        process.env.ANTHROPIC_API_KEY = "llm-key";
        process.env.PATENT_MCP_UV_DATA_DIR = fs.mkdtempSync(
            path.join(os.tmpdir(), "patent-env-"),
        );

        const env = patentMcpEnvironment();

        expect(env.USPTO_API_KEY).toBe("uspto-key");
        expect(env.TMSEARCH_WAF_TOKEN).toBe("waf-token");
        expect(env.TSDR_API_KEY).toBeUndefined();
        expect(env.SUPABASE_SECRET_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(PATENT_MCP_ENV_ALLOWLIST_KEYS).toContain("USPTO_API_KEY");
        for (const dir of [
            env.UV_CACHE_DIR,
            env.UV_TOOL_DIR,
            env.UV_PYTHON_INSTALL_DIR,
        ]) {
            expect(fs.existsSync(dir)).toBe(true);
        }
    });

    it("lets saved per-user credentials override deployment variables", () => {
        process.env.USPTO_API_KEY = "env-uspto";
        process.env.PATENT_MCP_UV_DATA_DIR = fs.mkdtempSync(
            path.join(os.tmpdir(), "patent-env-"),
        );

        const env = patentMcpEnvironment({
            usptoApiKey: "  user-uspto  ",
            tsdrApiKey: "user-tsdr",
        });

        expect(env.USPTO_API_KEY).toBe("user-uspto");
        expect(env.TSDR_API_KEY).toBe("user-tsdr");
        expect(env.TMSEARCH_WAF_TOKEN).toBeUndefined();
    });
});

describe("managed identity", () => {
    const baseRow: ConnectorRow = {
        id: "c1",
        user_id: "u1",
        name: "USPTO Patent & Trademark",
        transport: "stdio",
        server_url: PATENT_MCP_SERVER_URI,
        auth_type: "none",
        enabled: true,
        tool_policy: patentManagedToolPolicy(),
        encrypted_auth_config: null,
        auth_config_iv: null,
        auth_config_tag: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };

    it("records the runtime pins in the tool policy", () => {
        expect(patentManagedToolPolicy()).toEqual({
            managed: "patent_mcp_server",
            package: "patent-mcp-server==1.0.0",
            python: "3.13",
            mcp: "mcp[cli]>=1.27,<2",
            source: "https://github.com/riemannzeta/patent_mcp_server",
            source_commit:
                "67ff3136491a52637ef97dd0093b10542f488097",
        });
    });

    it("recognizes only the fixed USPTO stdio identity", () => {
        expect(isManagedPatentConnector(baseRow)).toBe(true);
        expect(
            isManagedPatentConnector({
                ...baseRow,
                server_url: "builtin://other-server",
            }),
        ).toBe(false);
        expect(
            isManagedPatentConnector({ ...baseRow, transport: "streamable_http" }),
        ).toBe(false);
        expect(
            isManagedPatentConnector({ ...baseRow, tool_policy: {} }),
        ).toBe(false);
    });

    it("detects the managed tool policy marker", () => {
        expect(isManagedPatentToolPolicy(patentManagedToolPolicy())).toBe(true);
        expect(isManagedPatentToolPolicy({})).toBe(false);
        expect(isManagedPatentToolPolicy(null)).toBe(false);
    });
});

describe("patentMcpFailureDetail", () => {
    it("returns the last error line, truncated, from a stderr tail", () => {
        const longLine = `Traceback ${"x".repeat(1000)}`;
        const tail = `info line\n${longLine}\n`;
        const detail = patentMcpFailureDetail(tail);
        expect(detail).not.toBeNull();
        expect(detail!.startsWith("Traceback xxx")).toBe(true);
        expect(detail!.length).toBeLessThanOrEqual(600);
    });

    it("returns null when the tail has no error line", () => {
        expect(patentMcpFailureDetail("starting server\nready")).toBeNull();
    });

    it("redacts stored credential values from the detail", () => {
        const detail = patentMcpFailureDetail(
            "request failed: header X-API-Key=secret-key-value",
            { usptoApiKey: "secret-key-value" },
        );
        expect(detail).not.toBeNull();
        expect(detail).toContain("[redacted]");
        expect(detail).not.toContain("secret-key-value");
    });

    it("redacts a short credential value from the detail", () => {
        const detail = patentMcpFailureDetail(
            "request failed: token=k",
            { tsdrApiKey: "k" },
        );
        expect(detail).not.toBeNull();
        expect(detail).toContain("[redacted]");
        expect(detail).not.toContain("=k");
    });

    it("redacts deployment credential values from the detail", () => {
        process.env.TMSEARCH_WAF_TOKEN = "env-waf-token-value";
        const detail = patentMcpFailureDetail(
            "error: cookie aws-waf-token=env-waf-token-value",
        );
        expect(detail).not.toBeNull();
        expect(detail).toContain("[redacted]");
        expect(detail).not.toContain("env-waf-token-value");
    });
});

function profileDb(
    result:
        | { data: { uspto_connector_enabled?: boolean | null } | null; error: null }
        | { data: null; error: { code: string; message: string } },
): Db {
    const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve(result),
    };
    return { from: () => chain } as unknown as Db;
}

describe("isUsptoConnectorEnabled", () => {
    it("is on only for an explicit true", async () => {
        expect(
            await isUsptoConnectorEnabled(
                profileDb({ data: { uspto_connector_enabled: true }, error: null }),
                "u1",
            ),
        ).toBe(true);
        expect(
            await isUsptoConnectorEnabled(
                profileDb({ data: { uspto_connector_enabled: false }, error: null }),
                "u1",
            ),
        ).toBe(false);
        expect(
            await isUsptoConnectorEnabled(
                profileDb({ data: { uspto_connector_enabled: null }, error: null }),
                "u1",
            ),
        ).toBe(false);
        expect(
            await isUsptoConnectorEnabled(
                profileDb({ data: null, error: null }),
                "u1",
            ),
        ).toBe(false);
    });

    it("treats a missing column (pre-migration database) as off", async () => {
        expect(
            await isUsptoConnectorEnabled(
                profileDb({
                    data: null,
                    error: {
                        code: "42703",
                        message: "column user_profiles.uspto_connector_enabled does not exist",
                    },
                }),
                "u1",
            ),
        ).toBe(false);
    });
});

describe("withPatentProcessSlot", () => {
    it("bounds concurrent processes and drains the queue", async () => {
        process.env.PATENT_MCP_MAX_CONCURRENT = "2";
        let active = 0;
        let peak = 0;
        const run = () =>
            withPatentProcessSlot(async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 10));
                active -= 1;
            });

        await Promise.all(Array.from({ length: 6 }, run));

        expect(peak).toBe(2);
        expect(active).toBe(0);
    });

    it("rejects a caller when the wait queue is full", async () => {
        process.env.PATENT_MCP_MAX_CONCURRENT = "1";
        process.env.PATENT_MCP_MAX_QUEUE = "1";
        let releaseFirst: () => void = () => {};
        const first = withPatentProcessSlot(
            () =>
                new Promise<void>((resolve) => {
                    releaseFirst = resolve;
                }),
        );
        const queued = withPatentProcessSlot(async () => undefined);

        await expect(
            withPatentProcessSlot(async () => undefined),
        ).rejects.toThrow(/busy/);

        // Let the first callback start so it publishes its release function.
        await Promise.resolve();
        releaseFirst();
        await first;
        await queued;
    });

    it("removes a timed-out waiter and rejects it", async () => {
        vi.useFakeTimers();
        try {
            process.env.PATENT_MCP_MAX_CONCURRENT = "1";
            process.env.PATENT_MCP_QUEUE_TIMEOUT_MS = "5000";
            let releaseFirst: () => void = () => {};
            const first = withPatentProcessSlot(
                () =>
                    new Promise<void>((resolve) => {
                        releaseFirst = resolve;
                    }),
            );
            const waiter = withPatentProcessSlot(async () => undefined);
            // Attach the rejection handler before the timer fires, so the
            // rejection is never unhandled.
            const waiterRejects = expect(waiter).rejects.toThrow(/busy/);

            await vi.advanceTimersByTimeAsync(5000);
            await waiterRejects;

            releaseFirst();
            await first;
        } finally {
            vi.useRealTimers();
        }
    });
});
