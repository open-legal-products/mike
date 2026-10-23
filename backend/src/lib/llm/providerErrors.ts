import type { ErrorKind } from "../appError";
import { UserFacingError } from "../userFacingError";
import { asInvalidApiKeyError, InvalidApiKeyError } from "./apiKeyErrors";

type ProviderContext = { label: string; modelId: string };

type ApiCallErrorLike = Error & { statusCode: number; responseBody?: string };

// The AI SDK is ESM-only here, so match its error shapes rather than importing
// APICallError / RetryError classes. Retried failures (e.g. 429s) arrive as a
// RetryError whose status code lives on `lastError`.
function findApiCallError(error: unknown): ApiCallErrorLike | null {
  if (!(error instanceof Error)) return null;
  if (typeof (error as Partial<ApiCallErrorLike>).statusCode === "number") {
    return error as ApiCallErrorLike;
  }
  const lastError = (error as { lastError?: unknown }).lastError;
  return lastError === undefined ? null : findApiCallError(lastError);
}

/**
 * The provider's HTTP answer behind `error`, including one wrapped as the
 * cause of a user-facing error, or null when it is not a provider answer.
 */
export function providerFailureResponse(
  error: unknown,
): { status: number; body: string } | null {
  let current = error;
  while (current) {
    const apiError = findApiCallError(current);
    if (apiError) {
      return { status: apiError.statusCode, body: apiError.responseBody ?? "" };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The HTTP status a model provider answered with, when `error` is the
 * provider's answer (an AI SDK APICallError, or a RetryError around one);
 * null for anything else — our own bugs, network failures, DB errors.
 */
export function providerFailureStatus(error: unknown): number | null {
  return findApiCallError(error)?.statusCode ?? null;
}

const NETWORK_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isNetworkFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof code === "string" && NETWORK_FAILURE_CODES.has(code)) return true;
    if (message === "fetch failed") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The `error_kind` a failed model call reports under: what the provider did,
 * not what we did with it. Rejected key or forbidden model, rate limit,
 * outage or unreachable (5xx, a stalled stream, a network failure), else the
 * generic stream failure. Read off the cause chain, so the error returned by
 * toProviderStreamError (a UserFacingError around the API error) classifies
 * the same as the API error itself.
 */
export function providerFailureKind(error: unknown): ErrorKind {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    if (current instanceof InvalidApiKeyError) return "chat.provider_rejected";
    current = (current as { cause?: unknown }).cause;
  }
  const response = providerFailureResponse(error);
  if (response) {
    if (response.status === 401 || response.status === 403) return "chat.provider_rejected";
    if (response.status === 429) return "chat.provider_rate_limited";
    if (response.status >= 500) return "chat.provider_unavailable";
    return "chat.stream_failed";
  }
  if (asProviderStallError(error, { label: "", modelId: "" }) || isNetworkFailure(error)) {
    return "chat.provider_unavailable";
  }
  return "chat.stream_failed";
}

// "The" rather than "your" key: requiredKey() may fall back to the
// deployment's key, as noted on InvalidApiKeyError.
function accessFailureMessage(
  { statusCode, responseBody = "" }: ApiCallErrorLike,
  { label, modelId }: ProviderContext,
): string | null {
  if (statusCode === 402) {
    return `The ${label} account is out of credits. Top up, or select another model.`;
  }
  if (statusCode === 403 || statusCode === 404) {
    return `${modelId} isn't available with the ${label} API key. Select another model.`;
  }
  if (statusCode === 429) {
    return /limit: 0\b/.test(responseBody)
      ? `The ${label} plan doesn't include ${modelId}. Select another model, or upgrade the ${label} plan.`
      : `${label} rate limit or quota reached. Wait a moment and try again, or select another model.`;
  }
  return null;
}

export function streamErrorMessage(error: unknown, label: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return `${label} stream failed.`;
}

// Provider deadline middleware uses the SDK-compatible TimeoutError wording.
const STALL_PATTERN = /\b(?:first chunk|chunk) timeout of \d+ms exceeded/i;

/**
 * A user-facing error when `reason` is a provider chunk timeout (the provider
 * stopped sending), else null. It must not read as a user cancel: the caller's
 * signal is not aborted, the model simply went quiet.
 */
export function asProviderStallError(
  reason: unknown,
  context: ProviderContext,
): UserFacingError | null {
  const text =
    reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? "");
  if (!STALL_PATTERN.test(text)) return null;
  return new UserFacingError(
    `${context.label} stopped responding, so the request was ended. Please try again, or select another model.`,
    { cause: reason },
  );
}

/**
 * Convert a provider failure into the error we throw.
 *
 * Key and access failures become `UserFacingError`s so the user is told what
 * to change rather than to "try again". Classification has to happen here,
 * before the error is flattened: the status code and response body live on
 * the AI SDK's `APICallError`.
 */
export function toProviderStreamError(
  error: unknown,
  context: ProviderContext,
): Error {
  const stalled = asProviderStallError(error, context);
  if (stalled) return stalled;
  const apiError = findApiCallError(error);
  const invalidKey = asInvalidApiKeyError(apiError ?? error, context.label);
  if (invalidKey) return invalidKey;
  const message = apiError && accessFailureMessage(apiError, context);
  if (message) return new UserFacingError(message, { cause: error });
  if (error instanceof Error && error.message) return error;
  return new Error(streamErrorMessage(error, context.label), { cause: error });
}
