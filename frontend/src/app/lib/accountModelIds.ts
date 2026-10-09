// Browser-side mirror of isSafeAccountModelId in
// backend/src/lib/llm/models.ts, so the settings typeahead refuses an id the
// server would drop and says why at the field. The backend stays
// authoritative; packages/byok-validation/cases.json keeps the two copies in
// step (both test suites assert against it).

/** Router slugs whose model ids are account-specific (typed, not listed). */
export const ACCOUNT_MODEL_PROVIDERS = [
  "bedrock",
  "azure",
  "azure-foundry",
  "vertex",
  "xai",
  "custom",
] as const;
export type AccountModelProvider = (typeof ACCOUNT_MODEL_PROVIDERS)[number];

const MAX_ACCOUNT_MODEL_ID_LENGTH = 200;
const ACCOUNT_MODEL_ID_SEGMENT_RE = /^[A-Za-z0-9._:@+-]+$/;

/**
 * True when `id` (without the router prefix) is a model id the backend
 * accepts for an account-specific provider: "/"-separated segments of
 * [A-Za-z0-9._:@+-] that are not all dots (no "..", "?", "#", "%" or empty
 * segments), at most 200 characters. Vertex ids have at most one "/", and
 * Claude ids on Vertex none.
 */
export function isSafeAccountModelId(
  provider: AccountModelProvider,
  id: string,
): boolean {
  if (!id || id.length > MAX_ACCOUNT_MODEL_ID_LENGTH) return false;
  // Protocol prefixes are removed before the id reaches the provider.
  // Validate that resulting path too, so "anthropic:.." cannot hide dots.
  const explicitProtocol =
    provider === "vertex" || provider === "azure-foundry"
      ? /^(anthropic|openai|gemini):/.exec(id)
      : null;
  const providerId = explicitProtocol
    ? id.slice(explicitProtocol[0].length)
    : id;
  const segments = providerId.split("/");
  if (
    segments.some(
      (segment) =>
        !ACCOUNT_MODEL_ID_SEGMENT_RE.test(segment) || /^\.+$/.test(segment),
    )
  ) {
    return false;
  }
  if (provider === "vertex") {
    if (segments.length > 2) return false;
    if (
      segments.length === 2 &&
      (explicitProtocol
        ? explicitProtocol[1] !== "openai"
        : providerId.startsWith("claude"))
    ) return false;
  }
  return true;
}
