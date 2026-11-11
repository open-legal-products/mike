import { addBreadcrumb } from "@sentry/node";

type Warning = { type?: string; feature?: string; setting?: string; message?: string };
type WarningOptions = { warnings?: Warning[]; provider?: string };
const seen = new Set<string>();

export function logProviderWarnings({ warnings = [], provider }: WarningOptions): void {
  for (const warning of warnings) {
    addBreadcrumb({ category: "mike.stage", message: "provider.compatibility", level: "warning" });
    const key = JSON.stringify([provider, warning.type, warning.feature, warning.setting]);
    if (seen.has(key)) continue;
    if (seen.size >= 256) seen.delete(seen.values().next().value!);
    seen.add(key);
    console.warn("[ai-sdk] provider compatibility warning", warning);
    if (warning.type === "deprecated") {
      process.emitWarning("AI SDK uses a deprecated provider setting; see the local compatibility warning", {
        type: "DeprecationWarning", code: "AI_SDK_DEPRECATION",
      });
    } else if (warning.type !== "unsupported" && warning.type !== "compatibility") {
      process.emitWarning("Unclassified AI SDK warning; see the local provider warning", { code: "AI_SDK_WARNING" });
    }
  }
}

/** Respect an operator-provided SDK logger or explicit opt-out. */
export function installProviderWarningLogger(): void {
  const runtime = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };
  if (runtime.AI_SDK_LOG_WARNINGS === undefined) runtime.AI_SDK_LOG_WARNINGS = logProviderWarnings;
}
