import type { ErrorKind } from "../appError";
import { UserFacingError } from "../userFacingError";
import { asInvalidApiKeyError, InvalidApiKeyError } from "./apiKeyErrors";

/**
 * Whose key a model call sent: the user's own, their organization's, or the
 * deployment's environment key, which requiredKey() and friends fall back to.
 */
export type ProviderKeySource = "user" | "org" | "deployment";

type ProviderContext = {
  label: string;
  modelId: string;
  keySource?: ProviderKeySource;
  /** The adapter's provider id ("claude", "openrouter", …). */
  provider?: string;
};

/**
 * Record on a failed call's error whose key it sent, and to which provider,
 * so the level rule can tell the operator's revoked key from a user's and
 * retain its ownership through wrappers. Non-enumerable: routing facts for
 * providerFailureLevel and reportModelFailure, not something to serialize
 * onto an event or a log line. Errors that cannot take a property are left
 * alone.
 */
export function withKeySource<T>(
  error: T,
  keySource: ProviderKeySource | undefined,
  provider?: string,
): T {
  if (
    keySource &&
    error &&
    typeof error === "object" &&
    Object.isExtensible(error) &&
    !Object.prototype.hasOwnProperty.call(error, "keySource")
  ) {
    Object.defineProperty(error, "keySource", {
      value: keySource,
      enumerable: false,
      configurable: true,
    });
    if (provider) {
      Object.defineProperty(error, "keyProvider", {
        value: provider,
        enumerable: false,
        configurable: true,
      });
    }
  }
  return error;
}

function providerKeySource(error: unknown): ProviderKeySource | undefined {
  for (const current of failureChain(error)) {
    const source = (current as { keySource?: unknown }).keySource;
    if (source === "user" || source === "org" || source === "deployment") return source;
  }
  return undefined;
}

type ApiCallErrorLike = Error & { statusCode: number; responseBody?: string };

// The AI SDK is ESM-only here, so match its error shapes rather than importing
// APICallError / RetryError classes. Retried failures (e.g. 429s) arrive as a
// RetryError whose status code lives on `lastError`.
function findApiCallError(error: unknown): ApiCallErrorLike | null {
  for (const current of failureChain(error)) {
    if (current instanceof Error && typeof (current as Partial<ApiCallErrorLike>).statusCode === "number") {
      return current as ApiCallErrorLike;
    }
  }
  return null;
}

/**
 * The provider's HTTP answer behind `error`, including one wrapped as the
 * cause of a user-facing error, or null when it is not a provider answer.
 */
export function providerFailureResponse(
  error: unknown,
): { status: number; body: string } | null {
  const apiError = findApiCallError(error);
  return apiError ? { status: apiError.statusCode, body: apiError.responseBody ?? "" } : null;
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
  // The provider stopped sending mid-body (undici's bodyTimeout): an outage,
  // like a dropped socket, not an unexplained stream failure.
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * The error and what it wraps, breadth-first and bounded: `cause` for our
 * own wrappers and undici's TypeError → SocketError, `lastError` for the AI
 * SDK's RetryError. A network failure that exhausted the SDK's retries sits
 * on `lastError.cause.cause`, which a `cause`-only walk never reached, so it
 * was filed as an unexplained `chat.stream_failed` (MIKE-BACKEND-88).
 */
function* failureChain(error: unknown): Generator<object> {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length && seen.size < 12) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    yield current;
    const { cause, lastError } = current as { cause?: unknown; lastError?: unknown };
    pending.push(cause, lastError);
  }
}

function isNetworkFailure(error: object): boolean {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (typeof code === "string" && NETWORK_FAILURE_CODES.has(code)) || message === "fetch failed";
}

/**
 * The `error_kind` a failed model call reports under: what the provider did,
 * not what we did with it. Rejected key or forbidden model, out of credits,
 * rate limit, outage or unreachable (5xx, a stalled stream, a network
 * failure), else the generic stream failure. Read off the cause chain, so the
 * error returned by toProviderStreamError (a UserFacingError around the API
 * error) classifies the same as the API error itself.
 */
export function providerFailureKind(error: unknown): ErrorKind {
  for (const current of failureChain(error)) {
    if (current instanceof InvalidApiKeyError) return "chat.provider_rejected";
  }
  const response = providerFailureResponse(error);
  if (response) {
    if (response.status === 401 || response.status === 403) return "chat.provider_rejected";
    // OpenRouter (and other prepaid gateways) answer 402 when the account
    // has no credit left: the account's state, like a rejected key.
    if (response.status === 402) return "chat.provider_out_of_credits";
    if (response.status === 429) return "chat.provider_rate_limited";
    if (response.status >= 500) return "chat.provider_unavailable";
    return "chat.stream_failed";
  }
  // A stall or a network failure may arrive wrapped (toProviderStreamError
  // around the first-chunk timeout, a RetryError around the socket error).
  for (const current of failureChain(error)) {
    if (asProviderStallError(current, { label: "", modelId: "" }) || isNetworkFailure(current)) {
      return "chat.provider_unavailable";
    }
  }
  return "chat.stream_failed";
}

/** A handled account refusal is quiet only at the boundary showing its remedy. */
export function isUserProviderRefusal(error: unknown): boolean {
  const kind = providerFailureKind(error);
  return providerKeySource(error) === "user" &&
    (kind === "chat.provider_rejected" || kind === "chat.provider_out_of_credits");
}

/** Unknown ownership and shared credential failures remain actionable errors. */
export function providerFailureLevel(error: unknown): "warning" | "error" {
  switch (providerFailureKind(error)) {
    case "chat.provider_rejected":
    case "chat.provider_out_of_credits":
      return isUserProviderRefusal(error) ? "warning" : "error";
    case "chat.provider_rate_limited":
    case "chat.provider_unavailable":
      return "warning";
    default:
      return "error";
  }
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
 * the AI SDK's `APICallError`. The result also records whose key was sent
 * (context.keySource), which decides whether a refusal is reported.
 */
export function toProviderStreamError(
  error: unknown,
  context: ProviderContext,
): Error {
  return withKeySource(
    classifyProviderStreamError(error, context),
    context.keySource,
    context.provider,
  );
}

function classifyProviderStreamError(error: unknown, context: ProviderContext): Error {
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
