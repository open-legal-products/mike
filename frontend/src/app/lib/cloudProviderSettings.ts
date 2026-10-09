// Browser-side mirror of backend/src/lib/llm/cloudProviders.ts validation, so
// a malformed region, endpoint, location or base URL is explained before the
// save round trip.
// The backend remains authoritative and re-validates every value.

const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const AZURE_RESOURCE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const AZURE_ENDPOINT_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
  ".services.ai.azure.com",
];

/** "us-east-1" for a valid AWS region code (any case), otherwise null. */
export function normalizeAwsRegion(value: string): string | null {
  const region = value.trim().toLowerCase();
  return AWS_REGION_RE.test(region) ? region : null;
}

/**
 * An Azure OpenAI resource name, or an https endpoint on an Azure AI
 * hostname without a trailing slash; otherwise null.
 */
export function normalizeAzureEndpoint(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300) return null;
  if (AZURE_RESOURCE_NAME_RE.test(trimmed)) return trimmed.toLowerCase();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !AZURE_ENDPOINT_HOST_SUFFIXES.some(
      (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
    )
  ) {
    return null;
  }
  return `https://${hostname}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The Azure AI Foundry resource as an https origin: a resource name becomes
 * https://{name}.services.ai.azure.com and a URL loses its path. Otherwise
 * null.
 */
export function normalizeAzureFoundryEndpoint(value: string): string | null {
  const trimmed = value.trim();
  if (AZURE_RESOURCE_NAME_RE.test(trimmed)) {
    return `https://${trimmed.toLowerCase()}.services.ai.azure.com`;
  }
  const endpoint = normalizeAzureEndpoint(trimmed);
  return endpoint ? new URL(endpoint).origin : null;
}

const VERTEX_LOCATION_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

/** "us-central1" or "global" for a Vertex AI location, otherwise null. */
export function normalizeVertexLocation(value: string): string | null {
  const location = value.trim().toLowerCase();
  return VERTEX_LOCATION_RE.test(location) ? location : null;
}

/**
 * A public https base URL without a trailing slash, otherwise null. The
 * backend additionally rejects private and reserved addresses, including
 * names that resolve to one.
 */
export function normalizeCustomBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 300) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    !hostname.includes(".")
  ) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Whether a pasted value looks like a Google Cloud service-account key file.
 * The backend validates the same fields more strictly.
 */
export function isVertexServiceAccountKey(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  return (
    record.type === "service_account" &&
    typeof record.project_id === "string" &&
    typeof record.client_email === "string" &&
    typeof record.private_key === "string"
  );
}
