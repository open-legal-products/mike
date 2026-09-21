// Managed USPTO Patent & Trademark connector adapter.
//
// This module is the only place that knows how the managed stdio connector
// runs the upstream `riemannzeta/patent_mcp_server` package. The browser and
// the database never supply an executable, argument, or path: the command
// line is fixed here. Trusted operator environment variables select between
// three fixed launch modes (preinstalled entrypoint, local upstream checkout,
// and the default pinned uvx download).
//
// The upstream project stays unmodified. Mike-specific search behavior lives
// in ./trademarkOwnerSearch and calls the server's published MCP tools.

import fs from "fs";
import path from "path";
import {
    getDefaultEnvironment,
    StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ConnectorRow, Db, McpManagedCredentials } from "./types";

// Fixed connector identity. The runtime version is recorded separately in
// the connector's tool policy, so an upstream pin change does not invalidate
// saved connectors.
export const PATENT_MCP_SERVER_URI = "builtin://patent-mcp-server";
export const PATENT_MCP_MANAGED_PROVIDER = "patent_mcp_server";
export const PATENT_MCP_CONNECTOR_NAME = "USPTO Patent & Trademark";

// Verified upstream pins. patent-mcp-server 1.0.0 on PyPI corresponds to
// upstream commit 67ff313 (uv.lock-only difference). The SDK constraint
// matches the upstream lockfile at that commit and excludes MCP SDK 2.x,
// which the server does not support.
export const PATENT_MCP_PACKAGE = "patent-mcp-server==1.0.0";
export const PATENT_MCP_PYTHON = "3.13";
export const PATENT_MCP_SDK = "mcp[cli]>=1.27,<2";
export const PATENT_MCP_SOURCE =
    "https://github.com/riemannzeta/patent_mcp_server";
export const PATENT_MCP_SOURCE_COMMIT =
    "67ff3136491a52637ef97dd0093b10542f488097";

// The first stdio connect can include a managed Python download on a native
// install, so it gets more time than a request. Requests keep the shared
// MCP_REQUEST_TIMEOUT_MS, except the paged trademark searches, which get
// their own bound below.
export const PATENT_MCP_CONNECT_TIMEOUT_MS = 180_000;
export const PATENT_MCP_TRADEMARK_TOOL_NAME = "tm_search_trademarks";
export const PATENT_MCP_TRADEMARK_TIMEOUT_MS = 10 * 60_000;

const STDERR_TAIL_CHARS = 8_000;
export { PATENT_MCP_ENV_ALLOWLIST as PATENT_MCP_ENV_ALLOWLIST_KEYS };
const STDERR_DETAIL_CHARS = 600;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_QUEUE = 32;
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;
const MIN_QUEUE_TIMEOUT_MS = 5_000;
const MAX_QUEUE_TIMEOUT_MS = 600_000;

// Only documented USPTO credentials and safe process tuning variables reach
// the child. Mike database credentials, LLM keys, and encryption secrets
// must never pass through.
const PATENT_MCP_ENV_ALLOWLIST = [
    "USPTO_API_KEY",
    "TSDR_API_KEY",
    "TMSEARCH_WAF_TOKEN",
    "LOG_LEVEL",
    "REQUEST_TIMEOUT",
    "MAX_RETRIES",
    "RETRY_MIN_WAIT",
    "RETRY_MAX_WAIT",
    "SESSION_EXPIRY_MINUTES",
    "ENABLE_CACHING",
] as const;

// Credentials saved through the web UI map to these child environment names.
// A saved value overrides the deployment environment variable, matching how
// user API keys override environment keys elsewhere in Mike.
const PATENT_MCP_CREDENTIAL_ENV: Record<
    keyof McpManagedCredentials,
    (typeof PATENT_MCP_ENV_ALLOWLIST)[number]
> = {
    usptoApiKey: "USPTO_API_KEY",
    tsdrApiKey: "TSDR_API_KEY",
    tmsearchWafToken: "TMSEARCH_WAF_TOKEN",
};

export const MANAGED_CONNECTOR_SETTINGS_LOCKED =
    "Managed local connector settings cannot be changed.";
export const MANAGED_CONNECTOR_DELETE_LOCKED =
    "Managed local connectors cannot be deleted. Disable the connector instead.";
export const MANAGED_CREDENTIALS_ONLY =
    "USPTO credentials apply only to the managed USPTO connector.";
export const MAX_MANAGED_CREDENTIAL_LENGTH = 4096;

export class UsptoConnectorDisabledError extends Error {
    readonly code = "feature_disabled";
    constructor() {
        super(
            "The USPTO Patent & Trademark feature is off. Turn it on in Settings > Features.",
        );
        this.name = "UsptoConnectorDisabledError";
    }
}

export class PatentRuntimeUnavailableError extends Error {
    readonly code = "runtime_unavailable";
    constructor(detail: string) {
        super(detail);
        this.name = "PatentRuntimeUnavailableError";
    }
}

export function isManagedPatentConnector(
    connector: Pick<ConnectorRow, "transport" | "server_url" | "tool_policy">,
): boolean {
    return (
        connector.transport === "stdio" &&
        connector.server_url === PATENT_MCP_SERVER_URI &&
        (connector.tool_policy as { managed?: unknown } | null)?.managed ===
            PATENT_MCP_MANAGED_PROVIDER
    );
}

export function isManagedPatentToolPolicy(
    toolPolicy: Record<string, unknown> | null | undefined,
): boolean {
    return toolPolicy?.managed === PATENT_MCP_MANAGED_PROVIDER;
}

export function patentManagedToolPolicy(): Record<string, unknown> {
    return {
        managed: PATENT_MCP_MANAGED_PROVIDER,
        package: PATENT_MCP_PACKAGE,
        python: PATENT_MCP_PYTHON,
        mcp: PATENT_MCP_SDK,
        source: PATENT_MCP_SOURCE,
        source_commit: PATENT_MCP_SOURCE_COMMIT,
    };
}

// Reads the per-user feature switch. A missing row, a NULL value, or a
// database that has not applied the migration (error 42703) all mean off.
export async function isUsptoConnectorEnabled(
    db: Db,
    userId: string,
): Promise<boolean> {
    const { data, error } = await db
        .from("user_profiles")
        .select("uspto_connector_enabled")
        .eq("user_id", userId)
        .maybeSingle();
    if (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== "42703") {
            console.error("[mcp-connectors] feature check failed", {
                userId,
                error: error.message,
            });
        }
        return false;
    }
    return (
        (data as { uspto_connector_enabled?: boolean | null } | null)
            ?.uspto_connector_enabled === true
    );
}

export async function requireUsptoConnectorEnabled(
    db: Db,
    userId: string,
): Promise<void> {
    if (!(await isUsptoConnectorEnabled(db, userId))) {
        throw new UsptoConnectorDisabledError();
    }
}

export function patentMcpEnvironment(
    credentials?: McpManagedCredentials,
): Record<string, string> {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const name of PATENT_MCP_ENV_ALLOWLIST) {
        const value = process.env[name]?.trim();
        if (value) env[name] = value;
    }
    // Per-user credentials win over deployment environment variables.
    for (const [field, name] of Object.entries(PATENT_MCP_CREDENTIAL_ENV)) {
        const value = credentials?.[field as keyof McpManagedCredentials]?.trim();
        if (value) env[name] = value;
    }
    // Package caches and managed runtimes stay in one writable data root so
    // temporary tool output never shares a directory with them.
    const uvDataDirectory =
        process.env.PATENT_MCP_UV_DATA_DIR?.trim() ||
        path.join(process.cwd(), "data", "uv");
    const dirs = {
        UV_CACHE_DIR: path.join(uvDataDirectory, "cache"),
        UV_TOOL_DIR: path.join(uvDataDirectory, "tools"),
        UV_PYTHON_INSTALL_DIR: path.join(uvDataDirectory, "python"),
    };
    for (const dir of Object.values(dirs)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    Object.assign(env, dirs);
    return env;
}

// Fixed command selection. Only trusted operator environment variables
// choose the mode; every mode runs the same pinned upstream entrypoint.
export function patentMcpLaunchSpec(): { command: string; args: string[] } {
    const executable = process.env.PATENT_MCP_EXECUTABLE?.trim();
    if (executable) {
        // Docker images preinstall the pinned tool with uv at build time and
        // set this to the bare entrypoint name. It must not contain a path
        // or shell syntax.
        if (!/^[A-Za-z0-9._-]+$/.test(executable)) {
            throw new PatentRuntimeUnavailableError(
                "PATENT_MCP_EXECUTABLE must be a bare executable name.",
            );
        }
        return { command: executable, args: [] };
    }
    const directory = process.env.PATENT_MCP_DIRECTORY?.trim();
    if (directory) {
        // Native development only: run an unmodified upstream checkout.
        return {
            command: "uv",
            args: [
                "--directory",
                directory,
                "run",
                "--python",
                PATENT_MCP_PYTHON,
                "--with",
                PATENT_MCP_SDK,
                "patent-mcp-server",
            ],
        };
    }
    return {
        command: "uvx",
        args: [
            "--python",
            PATENT_MCP_PYTHON,
            "--from",
            PATENT_MCP_PACKAGE,
            "--with",
            PATENT_MCP_SDK,
            "patent-mcp-server",
        ],
    };
}

export function createPatentMcpTransport(
    credentials?: McpManagedCredentials,
): StdioClientTransport {
    const { command, args } = patentMcpLaunchSpec();
    return new StdioClientTransport({
        command,
        args,
        env: patentMcpEnvironment(credentials),
        stderr: "pipe",
    });
}

// Bounds concurrent managed processes per backend instance. Excess callers
// queue in FIFO order until a slot frees. The queue has a fixed cap and an
// acquisition timeout, so a long trademark search cannot block callers
// without bound.
type ProcessWaiter = {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};
let activeProcesses = 0;
const processQueue: ProcessWaiter[] = [];

function envInt(
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= min) {
        return Math.min(parsed, max);
    }
    return fallback;
}

function maxConcurrentProcesses(): number {
    return envInt("PATENT_MCP_MAX_CONCURRENT", DEFAULT_MAX_CONCURRENT, 1, 16);
}

function maxQueuedProcesses(): number {
    return envInt("PATENT_MCP_MAX_QUEUE", DEFAULT_MAX_QUEUE, 1, 256);
}

function queueTimeoutMs(): number {
    return envInt(
        "PATENT_MCP_QUEUE_TIMEOUT_MS",
        DEFAULT_QUEUE_TIMEOUT_MS,
        MIN_QUEUE_TIMEOUT_MS,
        MAX_QUEUE_TIMEOUT_MS,
    );
}

async function acquireProcessSlot(): Promise<() => void> {
    if (activeProcesses < maxConcurrentProcesses()) {
        activeProcesses += 1;
        return releaseProcessSlot;
    }
    if (processQueue.length >= maxQueuedProcesses()) {
        throw new Error(
            "The USPTO connector is busy. Try again later.",
        );
    }
    await new Promise<void>((resolve, reject) => {
        const waiter: ProcessWaiter = {
            resolve,
            reject,
            timer: setTimeout(() => {
                const index = processQueue.indexOf(waiter);
                if (index !== -1) processQueue.splice(index, 1);
                reject(new Error("The USPTO connector is busy. Try again later."));
            }, queueTimeoutMs()),
        };
        processQueue.push(waiter);
    });
    return releaseProcessSlot;
}

function releaseProcessSlot() {
    // Hand the slot straight to the next waiter. Decrement only when the
    // queue is empty, so the count never dips while a slot is still busy.
    const next = processQueue.shift();
    if (next) {
        clearTimeout(next.timer);
        next.resolve();
        return;
    }
    activeProcesses -= 1;
}

export async function withPatentProcessSlot<T>(
    callback: () => Promise<T>,
): Promise<T> {
    const release = await acquireProcessSlot();
    try {
        return await callback();
    } finally {
        release();
    }
}

// Replaces known credential values in text with a redaction marker. Upstream
// debug output can echo request headers, so no credential value may reach a
// log line or a user-facing error.
export function redactPatentMcpSecrets(
    text: string,
    credentials?: McpManagedCredentials,
): string {
    const secrets = new Set<string>();
    for (const field of Object.keys(
        PATENT_MCP_CREDENTIAL_ENV,
    ) as Array<keyof McpManagedCredentials>) {
        const value = credentials?.[field]?.trim();
        if (value) secrets.add(value);
        const envValue = process.env[PATENT_MCP_CREDENTIAL_ENV[field]]?.trim();
        if (envValue) secrets.add(envValue);
    }
    let redacted = text;
    for (const secret of secrets) {
        redacted = redacted.split(secret).join("[redacted]");
    }
    return redacted;
}

// Reads a bounded stderr tail and returns one concise line for logs and
// user-facing diagnostics. Raw stderr is never forwarded verbatim, and known
// credential values are redacted first.
export function patentMcpFailureDetail(
    stderrTail: string,
    credentials?: McpManagedCredentials,
): string | null {
    // The error scan runs on the raw tail, then the selected line is redacted.
    // A very short credential would otherwise rewrite the words the scan
    // matches on and hide the real error line.
    const lines = stderrTail.split("\n").map((line) => line.trim());
    let selected: string | null = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (/(?:error|exception|traceback|failed)/i.test(lines[index])) {
            selected = lines[index];
            break;
        }
    }
    if (selected === null) return null;
    return redactPatentMcpSecrets(selected, credentials).slice(
        0,
        STDERR_DETAIL_CHARS,
    );
}

export { STDERR_TAIL_CHARS as PATENT_MCP_STDERR_TAIL_CHARS };
