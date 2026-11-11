import { addBreadcrumb } from "@sentry/node";
import { reportError } from "../observability/sentry";

type Warning = { type?: string; feature?: string; setting?: string; message?: string; details?: string };
type WarningOptions = { warnings?: Warning[]; provider?: string };
// Match the SDK's stable deprecation identifiers, never encode arbitrary settings.
const DEPRECATION_CODES = new Map([
  ["generateObject", "AISDK_DEP_GENERATE_OBJECT"],
  ["streamObject", "AISDK_DEP_STREAM_OBJECT"],
  ["experimental_generateSpeech", "AISDK_DEP_EXPERIMENTAL_GENERATE_SPEECH"],
  ["experimental_transcribe", "AISDK_DEP_EXPERIMENTAL_TRANSCRIBE"],
  ['"image" content part', "AISDK_DEP_IMAGE_CONTENT_PART"],
  ['"tool-result" content of type "file-data"', "AISDK_DEP_TOOL_RESULT_FILE_DATA"],
  ['"tool-result" content of type "file-url"', "AISDK_DEP_TOOL_RESULT_FILE_URL"],
  ['"tool-result" content of type "file-id"', "AISDK_DEP_TOOL_RESULT_FILE_ID"],
  ['"tool-result" content of type "file-reference"', "AISDK_DEP_TOOL_RESULT_FILE_REFERENCE"],
  ['"tool-result" content of type "image-data"', "AISDK_DEP_TOOL_RESULT_IMAGE_DATA"],
  ['"tool-result" content of type "image-url"', "AISDK_DEP_TOOL_RESULT_IMAGE_URL"],
  ['"tool-result" content of type "image-file-id"', "AISDK_DEP_TOOL_RESULT_IMAGE_FILE_ID"],
  ['"tool-result" content of type "image-file-reference"', "AISDK_DEP_TOOL_RESULT_IMAGE_FILE_REFERENCE"],
  ["rawInput in output-error UI message parts", "AISDK_DEP_UI_MESSAGE_RAW_INPUT"],
]);
const seen = new Map<string, number>();
const WARNING_COOLDOWN_MS = 5 * 60_000;
export function resetProviderWarningsForTests(): void { seen.clear(); }

export function logProviderWarnings({ warnings = [], provider }: WarningOptions): void {
  for (const warning of warnings) {
    addBreadcrumb({ category: "mike.stage", message: "provider.compatibility", level: "warning" });
    // A cooldown bounds per-request warnings without hiding a recurring
    // warning forever. Raw identity stays local and never becomes a tag.
    const key = JSON.stringify([provider, warning.type, warning.feature, warning.setting, warning.message, warning.details]);
    const now = Date.now();
    const previous = seen.get(key);
    if (previous !== undefined && now - previous < WARNING_COOLDOWN_MS) continue;
    if (seen.size >= 256) seen.delete(seen.keys().next().value!);
    seen.set(key, now);
    console.warn("[ai-sdk] provider compatibility warning", warning);
    if (warning.type === "unsupported" || warning.type === "compatibility") continue;
    const deprecated = warning.type === "deprecated";
    if (deprecated && process.noDeprecation) continue;
    const code = deprecated
      ? DEPRECATION_CODES.get(warning.setting ?? "") ?? "AI_SDK_DEPRECATION"
      : "AI_SDK_WARNING";
    // Capture here rather than re-emitting a synthetic process warning:
    // preserve the synchronous provider/SDK callsite and fixed setting code.
    const error = new Error("AI SDK warning; see the local provider warning");
    if (deprecated) error.name = "DeprecationWarning";
    else error.name = "Warning";
    reportError(error, {
      level: "warning",
      tags: { component: "provider-warning", operation: "llm.warning", warning_name: error.name, warning_code: code },
    });
  }
}

/** Respect an operator-provided SDK logger or explicit opt-out. */
export function installProviderWarningLogger(): void {
  const runtime = globalThis as { AI_SDK_LOG_WARNINGS?: unknown };
  if (runtime.AI_SDK_LOG_WARNINGS === undefined) runtime.AI_SDK_LOG_WARNINGS = logProviderWarnings;
}
