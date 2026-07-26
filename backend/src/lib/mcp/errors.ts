const MAX_MCP_ERROR_MESSAGE_CHARS = 2_000;
const POST_ERROR_MARKER = "Error POSTing to endpoint:";

type UnknownRecord = Record<string, unknown>;

export type McpErrorDiagnostic = {
    message: string;
    httpStatus?: number;
    mcpCode?: number | string;
    serverError?: {
        code?: number | string;
        status?: string;
        message: string;
    };
};

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as UnknownRecord)
        : null;
}

function truncate(value: string) {
    if (value.length <= MAX_MCP_ERROR_MESSAGE_CHARS) return value;
    return `${value.slice(0, MAX_MCP_ERROR_MESSAGE_CHARS)}…`;
}

function parseJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

function responseBodyFromMessage(message: string): unknown {
    const markerIndex = message.indexOf(POST_ERROR_MARKER);
    if (markerIndex < 0) return undefined;
    const body = message
        .slice(markerIndex + POST_ERROR_MARKER.length)
        .trim();
    return parseJson(body);
}

function serverErrorFrom(value: unknown): McpErrorDiagnostic["serverError"] {
    const record = asRecord(value);
    if (!record) return undefined;

    const nestedError = asRecord(record.error);
    const nestedData = asRecord(nestedError?.data ?? record.data);
    const candidate =
        nestedData && typeof nestedData.message === "string"
            ? nestedData
            : (nestedError ?? record);
    const message =
        typeof candidate.message === "string"
            ? candidate.message.trim()
            : typeof record.error === "string"
              ? record.error.trim()
              : "";
    if (!message) return undefined;

    return {
        ...(typeof candidate.code === "number" ||
        typeof candidate.code === "string"
            ? { code: candidate.code }
            : {}),
        ...(typeof candidate.status === "string"
            ? { status: candidate.status }
            : {}),
        message: truncate(message),
    };
}

function errorCode(error: unknown): number | string | undefined {
    const record = asRecord(error);
    return typeof record?.code === "number" ||
        typeof record?.code === "string"
        ? record.code
        : undefined;
}

/**
 * Converts SDK and remote-server failures into a compact diagnostic suitable
 * for both the model's tool result and server-side audit logs.
 *
 * In particular, Google's MCP endpoints can return a non-2xx HTTP status with
 * the entire public tools/list schema as the body. The MCP SDK embeds that body
 * in the thrown Error message. We retain the status and any real structured
 * error, but deliberately discard successful result payloads and other large
 * response bodies.
 */
export function formatMcpErrorForAgent(error: unknown): McpErrorDiagnostic {
    const rawMessage =
        error instanceof Error && error.message
            ? error.message
            : "MCP tool call failed.";
    const code = errorCode(error);
    const httpStatus =
        typeof code === "number" && code >= 100 && code <= 599
            ? code
            : undefined;
    const record = asRecord(error);
    const responseBody = responseBodyFromMessage(rawMessage);
    const serverError =
        serverErrorFrom(responseBody) ?? serverErrorFrom(record?.data);

    let message: string;
    if (httpStatus === 401) {
        message = "MCP server rejected the authentication (HTTP 401).";
    } else if (httpStatus === 403) {
        message = "MCP server denied permission (HTTP 403).";
    } else if (httpStatus) {
        message = `MCP server request failed (HTTP ${httpStatus}).`;
    } else if (serverError) {
        message = "MCP server returned an error.";
    } else {
        const markerIndex = rawMessage.indexOf(POST_ERROR_MARKER);
        message = truncate(
            markerIndex >= 0
                ? rawMessage.slice(0, markerIndex).trim()
                : rawMessage,
        );
    }

    if (
        serverError?.message &&
        !message
            .toLowerCase()
            .includes(serverError.message.toLowerCase())
    ) {
        message = `${message} ${serverError.message}`;
    }

    return {
        message: truncate(message),
        ...(httpStatus ? { httpStatus } : {}),
        ...(code !== undefined && httpStatus === undefined
            ? { mcpCode: code }
            : {}),
        ...(serverError ? { serverError } : {}),
    };
}

export function mcpToolResultErrorMessage(result: unknown): string | null {
    const record = asRecord(result);
    if (record?.isError !== true) return null;

    if (Array.isArray(record.content)) {
        const messages = record.content
            .map((item) => asRecord(item))
            .map((item) =>
                item?.type === "text" && typeof item.text === "string"
                    ? item.text.trim()
                    : "",
            )
            .filter(Boolean);
        if (messages.length) return truncate(messages.join("\n"));
    }

    const structuredError = serverErrorFrom(record.structuredContent);
    return structuredError?.message ?? "MCP server reported a tool error.";
}

export function sanitizeMcpToolErrorResult(result: unknown): UnknownRecord {
    const record = asRecord(result);
    if (!record) return { isError: true };

    const content = Array.isArray(record.content)
        ? record.content.map((item) => {
              const contentItem = asRecord(item);
              if (!contentItem) return { type: "unknown" };
              return {
                  type:
                      typeof contentItem.type === "string"
                          ? contentItem.type
                          : "unknown",
                  ...(contentItem.type === "text" &&
                  typeof contentItem.text === "string"
                      ? { text: truncate(contentItem.text.trim()) }
                      : {}),
              };
          })
        : undefined;
    const structuredError = serverErrorFrom(record.structuredContent);

    return {
        isError: true,
        ...(content ? { content } : {}),
        ...(structuredError ? { structuredError } : {}),
    };
}
