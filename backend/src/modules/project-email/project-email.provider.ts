import type { Db } from "../../lib/supabase";
import type { ConnectorOwner } from "../../lib/connectorOwner";
import { assertWorkspaceProviderAvailable, loadWorkspaceGrant, workspaceAccessToken, GoogleWorkspaceError } from "../../lib/integrations/googleWorkspaceAuth";
import { googleJson } from "../../lib/integrations/googleWorkspaceApi";
import { EMAIL_LIMITS, providerId } from "./project-email.mime";

export async function emailConnection(db: Db, owner: ConnectorOwner, expected?: { grant_id: string; account_id: string }) {
  assertWorkspaceProviderAvailable("gmail");
  const grant = await loadWorkspaceGrant(db, owner, "gmail");
  if (!grant || grant.enabled === false || !grant.account_id || !grant.grant_id || ["gmail_search", "gmail_read_message"].some(name => (grant.disabled_tools as string[] ?? []).includes(name))) {
    throw new GoogleWorkspaceError("Enable Gmail search and read in this workspace’s Connectors settings.");
  }
  if (expected && (grant.grant_id !== expected.grant_id || grant.account_id !== expected.account_id)) throw new GoogleWorkspaceError("Gmail connection changed. Preview the selection again.");
  return { grant_id: String(grant.grant_id), account_id: String(grant.account_id), account_email: String(grant.account_email) };
}

// Never accept arbitrary URLs or provider method names from the request/model.
// All requests are GETs through the existing capped Google HTTP transport.
export async function emailProvider(db: Db, owner: ConnectorOwner, expected: { grant_id: string; account_id: string }) {
  const get = async (path: string, params: Record<string, string> = {}) => {
    await emailConnection(db, owner, expected);
    const token = await workspaceAccessToken(db, owner, "gmail");
    return googleJson("gmail", token, path, params);
  };
  return {
    search: (query: string, page?: string) => get("/messages", { q: query, maxResults: String(EMAIL_LIMITS.messages), ...(page ? { pageToken: page } : {}) }),
    message: (id: string) => get(`/messages/${encodeURIComponent(providerId(id))}`, { format: "full" }),
    attachment: (message: string, attachment: string) => get(`/messages/${encodeURIComponent(providerId(message))}/attachments/${encodeURIComponent(providerId(attachment))}`),
  };
}
