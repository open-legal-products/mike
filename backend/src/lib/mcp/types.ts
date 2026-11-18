export type { Db } from "../supabase";

export type McpTransport = "streamable_http";
export type McpAuthType = "none" | "bearer" | "oauth";
export type McpConnectorAuthConfig = {
    bearerToken?: string;
    headers?: Record<string, string>;
};

export type McpConnectorSummary = {
    id: string;
    name: string;
    transport: McpTransport;
    serverUrl: string;
    authType: McpAuthType;
    enabled: boolean;
    /** Write tools wait for the user's approval in the conversation. */
    requireWriteApproval: boolean;
    /** Disables write tools while preserving individual tool choices. */
    readOnly?: boolean;
    hasAuthConfig: boolean;
    customHeaderKeys: string[];
    oauthConnected: boolean;
    toolPolicy: Record<string, unknown>;
    tools: McpToolSummary[];
    toolCount: number;
    createdAt: string;
    updatedAt: string;
};

export type McpToolSummary = {
    id: string;
    toolName: string;
    openaiToolName: string;
    title: string | null;
    description: string | null;
    enabled: boolean;
    readOnly: boolean;
    destructive: boolean;
    /** Potentially changes data, including tools without read-only annotations. */
    write: boolean;
    lastSeenAt: string;
};

export type { McpToolEvent } from "@mike/contracts";
import type { ConnectorApprovalItem, McpToolEvent } from "@mike/contracts";

/**
 * What to do with a connector tool call: run it now, pause for the user's
 * approval, or answer without running (the tool is unavailable or failed to
 * prepare). Shared by MCP, Google Workspace and Google Drive.
 */
export type ConnectorCallPlan =
    | { type: "run" }
    | { type: "approval"; item: Omit<ConnectorApprovalItem, "id"> }
    | { type: "result"; content: string; event: McpToolEvent };

export type ConnectorRow = {
    id: string;
    user_id: string;
    name: string;
    transport: McpTransport;
    server_url: string;
    auth_type: McpAuthType;
    enabled: boolean;
    require_write_approval?: boolean | null;
    read_only?: boolean;
    tool_policy: Record<string, unknown> | null;
    encrypted_auth_config: string | null;
    auth_config_iv: string | null;
    auth_config_tag: string | null;
    created_at: string;
    updated_at: string;
};

export type OAuthTokenRow = {
    id: string;
    /** Changes on interactive authorization, not access-token refresh. */
    grant_id?: string;
    connector_id: string;
    encrypted_access_token: string | null;
    access_token_iv: string | null;
    access_token_tag: string | null;
    encrypted_refresh_token: string | null;
    refresh_token_iv: string | null;
    refresh_token_tag: string | null;
    token_type: string | null;
    scope: string | null;
    expires_at: string | null;
    authorization_server: string | null;
    token_endpoint: string | null;
    client_id: string | null;
    encrypted_client_secret: string | null;
    client_secret_iv: string | null;
    client_secret_tag: string | null;
    resource: string | null;
    created_at: string;
    updated_at: string;
};

export type OAuthStateConfig = {
    codeVerifier: string;
    redirectUri: string;
    authorizationServer?: string;
    tokenEndpoint?: string;
    clientId?: string;
    clientSecret?: string;
    resource?: string;
    scope?: string;
};

export type OAuthMetadata = {
    authorizationServer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
    scopesSupported?: string[];
};

export type ToolCacheRow = {
    id: string;
    connector_id: string;
    tool_name: string;
    openai_tool_name: string;
    title: string | null;
    description: string | null;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown> | null;
    annotations: Record<string, unknown> | null;
    enabled: boolean;
    /** Write tool: stored under its historical column name. */
    requires_confirmation: boolean;
    last_seen_at: string;
};

/**
 * One successful MCP tool call, as made: the connector it ran on, the tool,
 * the arguments sent and the raw result. Source providers read it to
 * recognise a complete document carried in a result.
 */
export type McpCallRecord = {
    connectorId: string;
    serverUrl: string;
    toolName: string;
    arguments: Record<string, unknown>;
    result: unknown;
};

/** A read-only tool to run on whichever of the owner's connectors reaches a server. */
export type McpServerToolRequest = {
    serverUrl: string;
    toolName: string;
    arguments: Record<string, unknown>;
    /** Used when the owner still has it; otherwise any connector to the server. */
    preferConnectorId?: string;
};

/**
 * Whether two MCP server URLs name the same endpoint: same origin and path,
 * ignoring a trailing slash. A URL carrying credentials, a query or a
 * fragment matches nothing, so a lookalike cannot stand in for a provider.
 */
export function sameMcpServerUrl(a: string, b: string): boolean {
    const canonical = (value: string): string | null => {
        try {
            const url = new URL(value);
            if (url.username || url.password || url.search || url.hash) return null;
            return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
        } catch {
            return null;
        }
    };
    const left = canonical(a);
    return left !== null && left === canonical(b);
}

/** Caller-supplied policy for one tool call. */
export type McpCallOptions = {
    /**
     * Characters of the serialized result the model may receive for this
     * connector and tool, when the caller knows the server deserves more
     * than MAX_MCP_RESULT_CHARS (a document provider whose results are whole
     * judgments). Undefined or a smaller value keeps the general cap.
     */
    maxResultChars?: (call: Pick<McpCallRecord, "serverUrl" | "toolName">) => number | undefined;
};

export type McpToolCallResult = {
    /** The model-facing serialization, cut off at the call's cap (MAX_MCP_RESULT_CHARS unless raised). */
    content: string;
    event: McpToolEvent;
    /** Present only when the call ran and the server answered without error. */
    call?: McpCallRecord;
    /** The model received only the first part of the result, up to its cap. */
    truncated?: boolean;
};

export const CLIENT_INFO = { name: "mike-mcp-client", version: "1.0.0" };
/** Characters of one MCP tool result the model receives; the rest is cut off. */
export const MAX_MCP_RESULT_CHARS = 60000;
export const MCP_REQUEST_TIMEOUT_MS = 30000;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;
export const MAX_CUSTOM_HEADERS = 20;
export const MAX_CUSTOM_HEADER_VALUE_LENGTH = 4096;
export const BLOCKED_METADATA_HOSTS = new Set([
    "metadata.google.internal",
    "instance-data",
]);

/**
 * A URL's hostname as the egress host checks compare it: lower-cased and
 * without a fully-qualified name's root dot(s). "localhost." and
 * "metadata.google.internal." are the same hosts as without the dot, and the
 * checks below compare names exactly.
 */
export function canonicalHostname(url: URL): string {
    return url.hostname.toLowerCase().replace(/\.+$/, "");
}

/** Loopback and cloud-metadata names, which no guarded egress may reach. */
export function isBlockedHostname(hostname: string): boolean {
    return (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        BLOCKED_METADATA_HOSTS.has(hostname)
    );
}
