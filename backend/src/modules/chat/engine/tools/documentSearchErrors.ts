import type { DocumentSearchErrorCode } from "@mike/contracts";
import { schemaOutOfDateCode } from "../../../../lib/httpError";
import { diagnosticErrorTags } from "../../../../lib/observability/sentryPrivacy";
import type { ServiceFailure } from "../../../../lib/serviceResult";

const MESSAGES: Record<DocumentSearchErrorCode, string> = {
  schema_out_of_date:
    "Document search is unavailable because the server's database needs an update. Please contact your administrator.",
  invalid_search:
    "Document search needs a valid scope and a phrase of 2–500 characters, with a limit of 1–20 and a valid page offset.",
  search_timeout:
    "Document search took too long. Try a more specific phrase or a smaller search scope.",
  search_unavailable:
    "Document search is temporarily unavailable. Please try again shortly.",
  internal_error: "Document search could not be completed. Try again.",
};

/** Rebuild messages from fixed codes at the streaming and persistence boundary. */
export function documentSearchError(code: unknown): {
  error_code: DocumentSearchErrorCode;
  error: string;
} {
  const error_code = typeof code === "string" && Object.hasOwn(MESSAGES, code)
    ? code as DocumentSearchErrorCode : "internal_error";
  return { error_code, error: MESSAGES[error_code] };
}

/** Classify structured failures without inspecting or exposing database messages. */
export function documentSearchFailure(failure: ServiceFailure) {
  if (failure.kind === "validation") return documentSearchError("invalid_search");
  if (failure.kind === "unavailable") return documentSearchError("search_unavailable");
  if (failure.kind === "error") {
    if (schemaOutOfDateCode(failure.error)) return documentSearchError("schema_out_of_date");
    const { failure_code } = diagnosticErrorTags(failure.error);
    if (failure_code === "57014") return documentSearchError("search_timeout");
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "08006", "53300", "fetch_failed"].includes(String(failure_code))) {
      return documentSearchError("search_unavailable");
    }
  }
  return documentSearchError("internal_error");
}
