import { UserFacingError } from "../userFacingError";

/**
 * A provider rejected the API key we sent.
 *
 * This is a `UserFacingError` so the streaming layer marks it
 * `safe_to_display` and the client shows it instead of the generic
 * "response could not be completed". The message is ours, not the provider's:
 * provider text is treated as untrusted and only used to classify.
 */
export class InvalidApiKeyError extends UserFacingError {
  constructor(providerLabel: string, options?: ErrorOptions) {
    // Deliberately not "your key": requiredKey() falls back to the
    // deployment's environment key, so a revoked platform key would otherwise
    // tell every user to fix a key they never set.
    super(
      `The ${providerLabel} API key was rejected. If you added your own key, check it in Settings → Bring Your Own Keys; otherwise contact your administrator.`,
      options,
    );
    this.name = "InvalidApiKeyError";
  }
}

/**
 * Text a provider uses when the credential itself is the problem, as opposed
 * to the request being malformed or the account lacking access.
 *
 * Seen in the wild:
 *   Gemini    400 "API key not valid. Please pass a valid API key."
 *             (reason "API_KEY_INVALID")
 *   Anthropic 401 "invalid x-api-key" (type "authentication_error")
 *   OpenAI    401 "Incorrect API key provided" (code "invalid_api_key")
 */
const INVALID_KEY_TEXT =
  /(api[ _-]?key[^."]*\b(?:not valid|invalid|incorrect|expired)|invalid[ _-]?(?:x-)?api[ _-]?key|api_key_invalid|incorrect api key|authentication_error|invalid_authentication|unauthorized)/i;

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { statusCode?: unknown }).statusCode;
  return typeof code === "number" ? code : undefined;
}

/**
 * Everything the provider told us, flattened for classification only. The AI
 * SDK puts the useful signal in different places per provider: `message` for
 * Anthropic, the parsed `data` for Gemini, and occasionally only the raw
 * `responseBody`.
 */
function describeError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return typeof error === "string" ? error : "";
  }
  const parts: string[] = [];
  const { message, responseBody, data } = error as {
    message?: unknown;
    responseBody?: unknown;
    data?: unknown;
  };
  if (typeof message === "string") parts.push(message);
  if (typeof responseBody === "string") parts.push(responseBody);
  if (data !== undefined) {
    try {
      parts.push(JSON.stringify(data));
    } catch {
      // Circular or otherwise unserializable payloads carry no signal we need.
    }
  }
  return parts.join(" ");
}

/**
 * Whether a provider failure means "this API key is bad".
 *
 * 401 is unambiguous: every provider here uses it only for authentication.
 * 400 and 403 also cover malformed requests and per-model permission
 * problems, so those need the message to actually name the key — telling a
 * user to check a key that is fine would send them down the wrong path.
 */
export function isInvalidApiKeyError(error: unknown): boolean {
  const status = statusCodeOf(error);
  if (status === 401) return true;
  if (status !== 400 && status !== 403) return false;
  return INVALID_KEY_TEXT.test(describeError(error));
}

/**
 * Map a provider failure onto `InvalidApiKeyError` when the key is at fault,
 * leaving every other failure untouched for the caller's own handling.
 */
export function asInvalidApiKeyError(
  error: unknown,
  providerLabel: string,
): InvalidApiKeyError | null {
  return isInvalidApiKeyError(error)
    ? new InvalidApiKeyError(providerLabel, { cause: error })
    : null;
}
