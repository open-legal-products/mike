import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ grant: vi.fn(), token: vi.fn(), available: vi.fn(), json: vi.fn() }));
vi.mock("../../../lib/integrations/googleWorkspaceAuth", async original => ({ ...(await original<typeof import("../../../lib/integrations/googleWorkspaceAuth")>()), loadWorkspaceGrant: mocks.grant, workspaceAccessToken: mocks.token, assertWorkspaceProviderAvailable: mocks.available }));
vi.mock("../../../lib/integrations/googleWorkspaceApi", () => ({ googleJson: mocks.json }));
import { emailConnection, emailProvider } from "../project-email.provider";
import type { Db } from "../../../lib/supabase";
const db = {} as Db;
const owner = { userId: "actor", orgId: "organization" };
const grant = { grant_id: "grant", account_id: "mailbox", account_email: "fixture@example.invalid", enabled: true, encrypted_access_token: "synthetic-encrypted-field", refresh_token_tag: "synthetic-tag", provider: "gmail", read_only: true };
beforeEach(() => { vi.resetAllMocks(); mocks.grant.mockResolvedValue(grant); mocks.token.mockResolvedValue("synthetic-test-value"); mocks.json.mockResolvedValue({}); });
it("projects only non-secret identity fields, never the full grant row", async () => {
  expect(await emailConnection(db, owner)).toEqual({ grant_id: "grant", account_id: "mailbox", account_email: "fixture@example.invalid" });
  expect(mocks.grant).toHaveBeenCalledWith(db, owner, "gmail");
  expect(mocks.token).not.toHaveBeenCalled();
});
it.each([null, { ...grant, enabled: false }, { ...grant, disabled_tools: ["gmail_read_message"] }, { ...grant, disabled_tools: ["gmail_search"] }])("refuses disabled/private workspace connections before token access", async row => {
  mocks.grant.mockResolvedValue(row);
  await expect(emailConnection(db, owner)).rejects.toThrow(); expect(mocks.token).not.toHaveBeenCalled();
});
it("rejects connection replacement but allows a read-only provider grant", async () => {
  await expect(emailConnection(db, owner, { grant_id: "old", account_id: "mailbox" })).rejects.toThrow("changed");
  await expect(emailConnection(db, owner, grant)).resolves.toMatchObject({ account_id: "mailbox" });
});
it("has only bounded GET operations, rechecking the owner and grant on every call", async () => {
  const provider = await emailProvider(db, owner, grant);
  await provider.search("subject:fixture", "next"); await provider.message("abc"); await provider.attachment("abc", "def");
  expect(mocks.grant).toHaveBeenCalledTimes(3);
  expect(mocks.json.mock.calls).toEqual([
    ["gmail", "synthetic-test-value", "/messages", { q: "subject:fixture", maxResults: "5", pageToken: "next" }],
    ["gmail", "synthetic-test-value", "/messages/abc", { format: "full" }],
    ["gmail", "synthetic-test-value", "/messages/abc/attachments/def", {}],
  ]);
  expect(() => provider.message("../tokens")).toThrow("identifier");
  mocks.grant.mockResolvedValue({ ...grant, enabled: false });
  await expect(provider.message("abc")).rejects.toThrow();
  expect(mocks.json).toHaveBeenCalledTimes(3);
});
