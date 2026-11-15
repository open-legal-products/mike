import net from "net";
import { isDeepStrictEqual } from "node:util";
import type { McpSourceLink } from "@mike/contracts";
import { isBlockedIp } from "../privateIp";

const SOURCE_SCHEMA = "counterpedia.source_presence_projection/v0.1";
const SOURCE_TOOL = "counterpedia.get_source_presence";
const MAX_LINKS = 4;
const MAX_ID = 200;
const MAX_LABEL = 240;
const MAX_URL = 2_048;
type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : null;
}
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}
function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
function candidateObjects(result: unknown): unknown[] | null {
  const root = record(result);
  if (!root || root.isError === true) return null;
  const candidates: unknown[] = [];
  if (root.structuredContent !== undefined) candidates.push(root.structuredContent);
  for (const part of Array.isArray(root.content) ? root.content : []) {
    const item = record(part);
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    if (item.text.length > 131_072) return null;
    try { candidates.push(JSON.parse(item.text)); } catch { /* not a witness */ }
  }
  return candidates.length ? candidates : null;
}
function safePublicUrl(value: unknown): string | null {
  const raw = text(value, MAX_URL);
  if (!raw || raw !== value || !/^https?:\/\/[^/]/i.test(raw) || /[\s\\]/.test(raw)) return null;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (!(parsed.protocol === "https:" || parsed.protocol === "http:")) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname.includes(".") || hostname.endsWith(".") || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
  if (net.isIP(hostname) && isBlockedIp(hostname)) return null;
  return raw;
}
function addLink(links: McpSourceLink[], sourceId: string, label: string, url: string, basis: McpSourceLink["basis"]) {
  if (links.length >= MAX_LINKS || links.some((link) => link.url === url)) return;
  links.push({ source_id: sourceId, label, url, basis });
}

/** Extract only explicit Counterpedia Source-bound witnesses; never scrape arbitrary URLs. */
export function extractCounterpediaSourceLinks(toolName: string, args: Record<string, unknown>, result: unknown): McpSourceLink[] {
  if (toolName !== SOURCE_TOOL) return [];
  const requested = text(args.source_id, MAX_ID);
  const candidates = candidateObjects(result);
  if (!requested || !candidates?.length) return [];
  const first = candidates[0];
  if (candidates.some((candidate) => !sameJson(first, candidate))) return [];
  const root = record(first);
  if (!root || root.operation !== SOURCE_TOOL || root.source_id !== requested) return [];
  const presence = record(root.presence);
  const identity = record(presence?.identity);
  if (presence?.schema_version !== SOURCE_SCHEMA || identity?.source_id !== requested || identity.publication_status !== "public") return [];
  const label = text(identity.label, MAX_LABEL);
  if (!label) return [];
  const links: McpSourceLink[] = [];
  const discovery = record(presence.discovery);
  if (discovery?.status === "available" && Array.isArray(discovery.value)) {
    for (const item of discovery.value.slice(0, 32)) {
      const row = record(item);
      if (row?.source_id !== requested || row.producer_contract !== "acquisition.discovery_lineage_projection/v0.1") continue;
      const url = safePublicUrl(row.locator);
      if (url) addLink(links, requested, label, url, "discovery");
    }
  }
  const custody = record(presence.custody_observations);
  for (const item of custody?.status === "available" && Array.isArray(custody.value) ? custody.value.slice(0, 32) : []) {
    const row = record(item);
    const sourceRecord = record(row?.source_record);
    const association = record(row?.capture_association);
    const resolution = record(association?.identity_resolution);
    if (row?.resolution !== "RESOLVED_TO_SOURCE_RECORD" || sourceRecord?.publication_status !== "public" || sourceRecord.cp_source_id !== requested || association?.posture !== "RETAINED_CAPTURE_ASSOCIATED" || resolution?.posture !== "RESOLVED" || resolution.cp_source_id !== requested) continue;
    for (const observation of Array.isArray(row?.observations) ? row.observations.slice(0, 32) : []) {
      const observed = record(observation);
      if (observed?.kind !== "HTTP_RESPONSE") continue;
      const url = safePublicUrl(observed.locator);
      if (url) addLink(links, requested, label, url, "capture_observation");
    }
  }
  return links;
}
