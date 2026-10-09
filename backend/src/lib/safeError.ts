/** Diagnostics for credential-bearing integrations: never serialize provider
 * messages, response bodies, database details, URLs, or exception stacks. */
export function safeError(error: unknown): { category: string } {
    if (error instanceof TypeError) return { category: "type_error" };
    if (error instanceof SyntaxError) return { category: "invalid_response" };
    if (error instanceof Error) return { category: "operation_failed" };
    return { category: "unknown_failure" };
}
