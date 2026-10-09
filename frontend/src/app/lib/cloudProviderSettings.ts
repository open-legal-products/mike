// Browser-side mirror of backend/src/lib/llm/cloudProviders.ts validation, so
// a malformed region, endpoint, location or base URL is explained before the
// save round trip.
// The backend remains authoritative and re-validates every value;
// packages/byok-validation/cases.json keeps the base URL rule in step with it.

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

// The common non-public IPv6 literals: unspecified, loopback, unique-local
// (fc00::/7), link-local (fe80::/10) and IPv4-mapped. Like the IPv4 list
// this is only for inline feedback; the backend's checks stay authoritative.
function isPrivateIpv6(literal: string): boolean {
  if (!literal.includes(":")) return false;
  return (
    literal === "::" ||
    literal === "::1" ||
    /^f[cd][0-9a-f]{0,2}:/.test(literal) ||
    /^fe[89ab][0-9a-f]?:/.test(literal) ||
    literal.startsWith("::ffff:")
  );
}

/**
 * An IPv4 literal in a loopback, private, link-local (cloud metadata) or
 * carrier-grade NAT range. The URL parser already canonicalizes forms like
 * "10.1" to "10.0.0.1"; IPv6 literals fail the dotted-host check below.
 */
function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) {
    return false;
  }
  const [a, b] = parts.map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * A public https base URL without a trailing slash, otherwise null. Obvious
 * private IP literals are caught here for early feedback; the backend is
 * authoritative and also rejects other reserved addresses and names that
 * resolve to one.
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
  // "localhost." is localhost: drop the root-label dot(s) before the checks.
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  // URL keeps IPv6 literals bracketed ("[2606:4700::1]"); IPv4 is
  // normalized to dotted decimal. A literal has no dotted name to check;
  // the backend decides whether its address is public.
  const literalHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const isIpLiteral =
    /^[\d.]+$/.test(literalHost) || literalHost.includes(":");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    (!isIpLiteral && !hostname.includes(".")) ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(literalHost)
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
