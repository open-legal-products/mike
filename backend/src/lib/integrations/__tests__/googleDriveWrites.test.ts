import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorApprovalItem } from "@mike/contracts";
import { encryptString } from "../../mcp/client";
import { driveDb } from "./googleDriveDb";
import {
  buildGoogleDriveTools,
  executeGoogleDriveToolCall,
  executeApprovedGoogleDriveCall,
  planGoogleDriveCall,
  getGoogleDriveStatus,
  updateGoogleDriveSettings,
  setGoogleDriveToolEnabled,
  GOOGLE_DRIVE_SCOPE,
} from "../googleDrive";

const original = {
  id: "file-1",
  name: "Draft",
  mimeType: "text/plain",
  version: "1",
  parents: ["old-parent"],
  trashed: false,
};
let current = { ...original };
const calls: { url: URL; init: RequestInit }[] = [];
let writeResponse: () => Response | Promise<Response>;
function store(overrides: Record<string, unknown> = {}) {
  const token = encryptString("synthetic-token");
  return driveDb({
    tokenRow: {
      user_id: "user-1",
      grant_id: "grant-1",
      scope: GOOGLE_DRIVE_SCOPE,
      encrypted_access_token: token.encrypted,
      access_token_iv: token.iv,
      access_token_tag: token.tag,
      expires_at: "2099-01-01T00:00:00Z",
      enabled: true,
      require_write_approval: false,
      disabled_tools: [],
      ...overrides,
    },
  });
}
beforeEach(() => {
  vi.stubEnv("MCP_CONNECTORS_ENCRYPTION_SECRET", "synthetic-secret");
  vi.spyOn(console, "error").mockImplementation(() => {});
  current = { ...original };
  calls.length = 0;
  writeResponse = () => Response.json({ id: "file-1", version: "2" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(input);
      calls.push({ url, init });
      if (init.method && init.method !== "GET") return writeResponse();
      return Response.json(
        url.pathname.endsWith("/folder-1")
          ? {
              id: "folder-1",
              name: "Destination",
              mimeType: "application/vnd.google-apps.folder",
              version: "1",
            }
          : current,
        { headers: { ETag: '"reviewed-etag"' } },
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mutations = () =>
  calls.filter((call) => call.init.method && call.init.method !== "GET");
async function approval(
  db: ReturnType<typeof store>["db"],
  name = "google_drive_update_file",
  args: Record<string, unknown> = { file_id: "file-1", name: "Reviewed name" },
) {
  const plan = await planGoogleDriveCall("user-1", name, args, db);
  expect(plan.type).toBe("approval");
  if (plan.type !== "approval") throw new Error("Expected approval");
  return { ...plan.item, id: "approval-1" } satisfies ConnectorApprovalItem;
}

describe("Drive write access", () => {
  it("read-only overrides all writes while preserving individual choices", async () => {
    const s = store({ disabled_tools: ["google_drive_trash_file", "google_drive_list_recent"] });
    await updateGoogleDriveSettings("user-1", { readOnly: true }, s.db);
    const status = await getGoogleDriveStatus("user-1", s.db);
    expect(status.readOnly).toBe(true);
    expect(status.tools.filter(t => t.write).every(t => !t.enabled)).toBe(true);
    expect(status.tools.find(t => t.name === "google_drive_search")?.enabled).toBe(true);
    expect(status.tools.find(t => t.name === "google_drive_list_recent")?.enabled).toBe(false);
    const names = JSON.stringify(await buildGoogleDriveTools("user-1", s.db));
    expect(names).toContain("google_drive_search");
    expect(names).not.toContain("google_drive_create_file");
    expect((await planGoogleDriveCall("user-1", "google_drive_create_folder", { name: "Folder" }, s.db)).type).toBe("result");
    expect(fetch).not.toHaveBeenCalled();
    await updateGoogleDriveSettings("user-1", { readOnly: false }, s.db);
    const restored = await getGoogleDriveStatus("user-1", s.db);
    expect(restored.readOnly).toBe(false);
    expect(restored.tools.find(t => t.name === "google_drive_create_file")?.enabled).toBe(true);
    expect(restored.tools.find(t => t.name === "google_drive_trash_file")?.enabled).toBe(false);
    expect(s.tokens[0].disabled_tools).toEqual(["google_drive_trash_file", "google_drive_list_recent"]);
  });

  it("blocks a write when read-only is enabled during metadata reads", async () => {
    const s = store();
    vi.mocked(fetch).mockImplementation(async () => {
      s.tokens[0].read_only = true;
      return Response.json(current);
    });
    const result = await executeGoogleDriveToolCall("user-1", "google_drive_update_file", { file_id: "file-1", name: "Changed" }, s.db);
    expect(result.event.status).toBe("error");
    expect(result.content).toContain("read-only");
    expect(vi.mocked(fetch).mock.calls.every(([,init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("discovers all write tools only with a full grant, honoring settings", async () => {
    const s = store();
    const names = async () =>
      (
        (await buildGoogleDriveTools("user-1", s.db)) as {
          function: { name: string };
        }[]
      ).map((t) => t.function.name);
    expect(await names()).toHaveLength(11);
    expect(await getGoogleDriveStatus("user-1", s.db)).toMatchObject({
      writeEnabled: true,
      requireWriteApproval: false,
      grantId: "grant-1",
    });
    await setGoogleDriveToolEnabled(
      "user-1",
      "google_drive_trash_file",
      false,
      s.db,
    );
    expect(await names()).not.toContain("google_drive_trash_file");
    await updateGoogleDriveSettings(
      "user-1",
      { requireWriteApproval: true },
      s.db,
    );
    expect(s.tokens[0].require_write_approval).toBe(true);
    s.tokens[0].scope = "https://www.googleapis.com/auth/drive.readonly";
    expect(await names()).toEqual([
      "google_drive_search",
      "google_drive_read_file",
      "google_drive_list_recent",
    ]);
    expect(await getGoogleDriveStatus("user-1", s.db)).toMatchObject({
      writeEnabled: false,
    });
    expect(await buildGoogleDriveTools("other-user", s.db)).toEqual([]);
  });

  it.each([
    { scope: "https://www.googleapis.com/auth/drive.readonly" },
    { enabled: false },
    { read_only: true },
    { disabled_tools: ["google_drive_update_file"] },
    { grant_id: undefined },
    { require_write_approval: true },
  ])(
    "blocks direct writes when unavailable or requiring approval: %j",
    async (settings) => {
      const result = await executeGoogleDriveToolCall(
        "user-1",
        "google_drive_update_file",
        { file_id: "file-1", name: "Changed" },
        store(settings).db,
      );
      expect(result.event.status).toBe("error");
      expect(calls).toEqual([]);
    },
  );

  it.each([
    { file_id: "../files/other", name: "Changed" },
    { file_id: "file-1" },
    { file_id: "file-1", name: "Changed", permissions: [{ type: "anyone" }] },
  ])(
    "rejects invalid or unexpected fields before any Google request",
    async (args) => {
      expect(
        (
          await executeGoogleDriveToolCall(
            "user-1",
            "google_drive_update_file",
            args,
            store().db,
          )
        ).event.status,
      ).toBe("error");
      expect(calls).toEqual([]);
    },
  );
});

describe("Drive write HTTP operations", () => {
  it.each([
    [
      "google_drive_create_file",
      {
        name: "Letter",
        content: "Dear 王\nTerms",
        file_type: "google_doc",
        parent_id: "folder-1",
      },
      "POST",
      "/upload/drive/v3/files",
    ],
    [
      "google_drive_create_folder",
      { name: "Matter", parent_id: "folder-1" },
      "POST",
      "/drive/v3/files",
    ],
    [
      "google_drive_update_file",
      { file_id: "file-1", name: "Final", description: "Reviewed" },
      "PATCH",
      "/drive/v3/files/file-1",
    ],
    [
      "google_drive_replace_file_content",
      { file_id: "file-1", content: "Entire new content" },
      "PATCH",
      "/upload/drive/v3/files/file-1",
    ],
    [
      "google_drive_move_file",
      { file_id: "file-1", parent_id: "folder-1" },
      "PATCH",
      "/drive/v3/files/file-1",
    ],
    [
      "google_drive_copy_file",
      { file_id: "file-1", name: "Copy", parent_id: "folder-1" },
      "POST",
      "/drive/v3/files/file-1/copy",
    ],
    [
      "google_drive_trash_file",
      { file_id: "file-1" },
      "PATCH",
      "/drive/v3/files/file-1",
    ],
    [
      "google_drive_restore_file",
      { file_id: "file-1" },
      "PATCH",
      "/drive/v3/files/file-1",
    ],
  ] as const)(
    "executes %s using the bounded Drive transport",
    async (name, args, method, path) => {
      if (name === "google_drive_restore_file") current.trashed = true;
      const result = await executeGoogleDriveToolCall(
        "user-1",
        name,
        args,
        store().db,
      );
      expect(result.event.status).toBe("ok");
      expect(mutations()).toHaveLength(1);
      const request = mutations()[0];
      expect(request.url.pathname).toBe(path);
      expect(request.init.method).toBe(method);
      expect(request.url.searchParams.get("supportsAllDrives")).toBe("true");
      if (method === "PATCH")
        expect(new Headers(request.init.headers).get("If-Match")).toBe(
          '"reviewed-etag"',
        );
      if (name === "google_drive_create_file") {
        expect(request.url.searchParams.get("uploadType")).toBe("multipart");
        expect(request.init.body).toContain(
          '"mimeType":"application/vnd.google-apps.document"',
        );
        expect(request.init.body).toContain("Dear 王\nTerms");
      }
      if (name === "google_drive_move_file") {
        expect(request.url.searchParams.get("addParents")).toBe("folder-1");
        expect(request.url.searchParams.get("removeParents")).toBe(
          "old-parent",
        );
      }
      if (name === "google_drive_trash_file")
        expect(JSON.parse(String(request.init.body))).toEqual({
          trashed: true,
        });
      if (name === "google_drive_restore_file")
        expect(JSON.parse(String(request.init.body))).toEqual({
          trashed: false,
        });
    },
  );

  it("refuses content replacement for binary and spreadsheet files", async () => {
    current.mimeType = "application/vnd.google-apps.spreadsheet";
    const result = await executeGoogleDriveToolCall(
      "user-1",
      "google_drive_replace_file_content",
      { file_id: "file-1", content: "new" },
      store().db,
    );
    expect(result.event.error).toContain(
      "plain-text files and Google Docs only",
    );
    expect(mutations()).toEqual([]);
  });

  it.each([403, 412, 500, "timeout"])(
    "reports %s without retrying or exposing Google error bodies",
    async (status) => {
      writeResponse = () => {
        if (status === "timeout") throw new Error("private transport details");
        return new Response("private Google error", { status: Number(status) });
      };
      const result = await executeGoogleDriveToolCall(
        "user-1",
        "google_drive_trash_file",
        { file_id: "file-1" },
        store().db,
      );
      expect(result.event.status).toBe("error");
      expect(result.content).not.toContain("private");
      expect(result.content.includes("outcome is uncertain")).toBe(
        status === 500 || status === "timeout",
      );
      expect(mutations()).toHaveLength(1);
    },
  );
});

describe("Drive write approvals", () => {
  it("rechecks the grant after metadata reads and before sending a mutation", async () => {
    const s = store({ require_write_approval: true });
    const item = await approval(s.db);
    vi.mocked(fetch).mockImplementationOnce(async () => {
      s.tokens[0].grant_id = "new-connection";
      return Response.json(current);
    });
    expect(
      (await executeApprovedGoogleDriveCall("user-1", item, s.db)).event.status,
    ).toBe("error");
    expect(mutations()).toEqual([]);
  });

  it("reviews source metadata without writing, then executes the persisted arguments", async () => {
    const s = store({ require_write_approval: true });
    const item = await approval(s.db);
    expect(item).toMatchObject({
      before: { file: original },
      binding: { provider: "google-drive", grant_id: "grant-1" },
    });
    expect(mutations()).toEqual([]);
    expect(
      (await executeApprovedGoogleDriveCall("user-1", item, s.db)).event.status,
    ).toBe("ok");
    expect(JSON.parse(String(mutations()[0].init.body))).toEqual({
      name: "Reviewed name",
    });
  });

  it.each(["grant", "disabled", "read-only-mode", "scope", "tool", "file", "actor"])(
    "refuses approval after %s changes",
    async (change) => {
      const s = store({ require_write_approval: true });
      const item = await approval(s.db);
      if (change === "grant") s.tokens[0].grant_id = "replacement";
      if (change === "disabled") s.tokens[0].enabled = false;
      if (change === "read-only-mode") s.tokens[0].read_only = true;
      if (change === "scope")
        s.tokens[0].scope = "https://www.googleapis.com/auth/drive.readonly";
      if (change === "tool") s.tokens[0].disabled_tools = [item.tool_name];
      if (change === "file") current.version = "2";
      const result = await executeApprovedGoogleDriveCall(
        change === "actor" ? "other-user" : "user-1",
        item,
        s.db,
      );
      expect(result.event.status).toBe("error");
      expect(mutations()).toEqual([]);
    },
  );
});
