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
    requiresConfirmation: boolean;
    lastSeenAt: string;
};

export type McpToolEvent =
    | {
          type: "mcp_tool_call";
          connector_id: string;
          connector_name: string;
          tool_name: string;
          openai_tool_name: string;
          status: "ok" | "error";
          error?: string;
      };

export type ConnectorRow = {
    id: string;
    user_id: string;
    name: string;
    transport: McpTransport;
    server_url: string;
    auth_type: McpAuthType;
    enabled: boolean;
    tool_policy: Record<string, unknown> | null;
    encrypted_auth_config: string | null;
    auth_config_iv: string | null;
    auth_config_tag: string | null;
    created_at: string;
    updated_at: string;
};

export type OAuthTokenRow = {
    id: string;
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
    requires_confirmation: boolean;
    last_seen_at: string;
};

export const CLIENT_INFO = { name: "mike-mcp-client", version: "1.0.0" };
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
