/** Server-owned preset; a matching model name alone never opts a user in. */
export function usesDesktopStarterPreset(model: string, baseURL: string): boolean {
  const managed = process.env.MIKE_DESKTOP_LOCAL_MODEL?.trim();
  if (
    (managed !== "qwen3.5:2b" && managed !== "qwen3.5:4b") ||
    model !== managed
  ) return false;
  try {
    const endpoint = new URL(baseURL);
    return (
      (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    );
  } catch {
    return false;
  }
}

/** Chat selection uses the provider-qualified ID, unlike Ollama's API. */
export function usesDesktopStarterChatPreset(model?: string): boolean {
  return !!model?.startsWith("ollama/") && usesDesktopStarterPreset(
    model.slice("ollama/".length),
    process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1",
  );
}

/** Prefer stable, short factual answers while preserving an explicit temperature. */
export function desktopStarterRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, reasoning_effort: "none", temperature: body.temperature ?? 0 };
}
