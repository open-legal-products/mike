import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { workspaceDb } from "./googleWorkspaceDb";
import {
  startWorkspaceOAuth,
  completeWorkspaceOAuth,
  cancelWorkspaceOAuth,
  disconnectWorkspace,
  workspaceStatus,
  workspaceAccessToken,
  requiredScopes,
  encryptFields,
  decryptFields,
} from "../googleWorkspaceAuth";
import {
  buildGoogleWorkspaceTools,
  executeGoogleWorkspaceToolCall,
  approveWorkspaceAction,
  listWorkspaceActions,
  rejectWorkspaceAction,
} from "../googleWorkspace";
import {
  parseWorkspaceTool,
  readableMessage,
  readWorkspaceTool,
  prepareWorkspaceAction,
  executeWorkspaceAction,
  WORKSPACE_TOOLS,
} from "../googleWorkspaceApi";

const json = (v: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(v), { status });
let fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", "test-secret");
  vi.stubEnv("MCP_CONNECTORS_ENCRYPTION_SECRET", "test-encryption-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function connected(
  write = false,
  provider: "gmail" | "google-calendar" = "gmail",
) {
  const store = workspaceDb();
  const { authorizationUrl } = await startWorkspaceOAuth(
    store.db,
    "u1",
    provider,
    "http://localhost:3000/api/callback",
    write,
  );
  fetchMock
    .mockResolvedValueOnce(
      json({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        scope: requiredScopes(provider, write).join(" "),
        expires_in: 3600,
      }),
    )
    .mockResolvedValueOnce(
      json({
        email: "different-google-account@example.com",
        email_verified: true,
        sub: "google-account-2",
      }),
    );
  await completeWorkspaceOAuth(
    store.db,
    "u1",
    provider,
    new URL(authorizationUrl).searchParams.get("state")!,
    "code",
  );
  fetchMock.mockClear();
  return store;
}
const email = {
  to: ["recipient@example.com"],
  subject: "Test email",
  body: "Test body",
};
async function proposal(store: ReturnType<typeof workspaceDb>) {
  const result = await executeGoogleWorkspaceToolCall(
    "u1",
    "gmail_propose_send",
    email,
    store.db,
  );
  expect(JSON.parse(result.content).data.status).toBe("awaiting_approval");
  return String(store.tables.google_workspace_actions.at(-1)!.id);
}

describe("Google Workspace opt-in and OAuth", () => {
  it("starts disconnected without deriving a grant from the signed-in user", async () => {
    const store = workspaceDb();
    expect(await workspaceStatus(store.db, "sso-user", "gmail")).toMatchObject({
      connected: false,
      writeEnabled: false,
    });
    expect(await buildGoogleWorkspaceTools("sso-user", store.db)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["gmail", "google-calendar"] as const)(
    "requests only read permissions by default and always offers account choice: %s",
    async (provider) => {
      const store = workspaceDb();
      const { authorizationUrl } = await startWorkspaceOAuth(
        store.db,
        "u1",
        provider,
        "https://mike.test/callback",
      );
      const url = new URL(authorizationUrl);
      expect(url.searchParams.get("scope")?.split(" ")).toEqual(
        requiredScopes(provider, false),
      );
      expect(url.searchParams.get("prompt")).toBe("select_account consent");
      expect(url.searchParams.has("login_hint")).toBe(false);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(JSON.stringify(store.tables)).not.toContain(
        url.searchParams.get("state"),
      );
      expect(store.tables.google_workspace_oauth_states[0].write_enabled).toBe(
        false,
      );
    },
  );
  it("stores selected account identity separately from the Mike identity and encrypts secrets", async () => {
    const s = await connected();
    const status = await workspaceStatus(s.db, "u1", "gmail");
    expect(status.accountEmail).toBe("different-google-account@example.com");
    expect(JSON.stringify(status)).not.toContain("access-secret");
    expect(JSON.stringify(s.tables)).not.toContain("refresh-secret");
    expect(await workspaceStatus(s.db, "u2", "gmail")).toMatchObject({
      connected: false,
    });
    expect(await workspaceStatus(s.db, "u1", "google-calendar")).toMatchObject({
      connected: false,
    });
  });
  it("does not mix credentials from an incomplete dedicated profile", async () => {
    vi.stubEnv("GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "other-secret");
    await expect(
      startWorkspaceOAuth(workspaceDb().db, "u", "gmail", "http://localhost"),
    ).rejects.toThrow("Configure");
  });
  it("rejects cross-provider and cancelled states before contacting Google", async () => {
    const s = workspaceDb();
    const start = await startWorkspaceOAuth(
      s.db,
      "u1",
      "gmail",
      "https://mike.test",
    );
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    await expect(
      completeWorkspaceOAuth(s.db, "u1", "google-calendar", state, "code"),
    ).rejects.toThrow("expired");
    await cancelWorkspaceOAuth(s.db, "u2", "gmail", state);
    expect(s.tables.google_workspace_oauth_states).toHaveLength(1);
    await cancelWorkspaceOAuth(s.db, "u1", "gmail", state);
    await expect(
      completeWorkspaceOAuth(s.db, "u1", "gmail", state, "code"),
    ).rejects.toThrow("expired");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["gmail", "google-calendar"] as const)(
    "rejects %s consent from a different Mike user before token exchange",
    async (provider) => {
      const s = workspaceDb();
      const { authorizationUrl } = await startWorkspaceOAuth(
        s.db,
        "attacker",
        provider,
        "https://mike.test/api/callback",
        false,
      );
      const state = new URL(authorizationUrl).searchParams.get("state")!;
      await expect(
        completeWorkspaceOAuth(s.db, "victim", provider, state, "code"),
      ).rejects.toThrow("expired");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(s.tables.user_google_workspace_tokens).toHaveLength(0);
      expect(s.tables.google_workspace_oauth_states).toHaveLength(1);
    },
  );
  it("rejects missing write scopes and never saves a partial grant", async () => {
    const s = workspaceDb();
    const start = await startWorkspaceOAuth(
      s.db,
      "u1",
      "gmail",
      "https://mike.test",
      true,
    );
    fetchMock.mockResolvedValueOnce(
      json({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        scope: requiredScopes("gmail", false).join(" "),
      }),
    );
    await expect(
      completeWorkspaceOAuth(
        s.db,
        "u1",
        "gmail",
        new URL(start.authorizationUrl).searchParams.get("state")!,
        "code",
      ),
    ).rejects.toThrow("permissions");
    expect(s.tables.user_google_workspace_tokens).toHaveLength(0);
  });
  it("cannot reconnect after a disconnect during code exchange", async () => {
    const s = workspaceDb();
    const start = await startWorkspaceOAuth(
      s.db,
      "u1",
      "gmail",
      "https://mike.test",
    );
    fetchMock
      .mockImplementationOnce(async () => {
        await disconnectWorkspace(s.db, "u1", "gmail");
        return json({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
          scope: requiredScopes("gmail", false).join(" "),
        });
      })
      .mockResolvedValueOnce(
        json({ email: "other@example.com", email_verified: true, sub: "1" }),
      );
    await expect(
      completeWorkspaceOAuth(
        s.db,
        "u1",
        "gmail",
        new URL(start.authorizationUrl).searchParams.get("state")!,
        "code",
      ),
    ).rejects.toThrow("cancelled");
    expect(s.tables.user_google_workspace_tokens).toHaveLength(0);
  });
  it("refreshes without losing refresh credentials, and does not resurrect a disconnected grant", async () => {
    const s = await connected();
    const row = s.tables.user_google_workspace_tokens[0];
    row.expires_at = "2000-01-01";
    fetchMock.mockResolvedValueOnce(
      json({ access_token: "fresh", expires_in: 3600 }),
    );
    expect(await workspaceAccessToken(s.db, "u1", "gmail")).toBe("fresh");
    expect(decryptFields(row, "refresh_token")).toBe("refresh-secret");
    row.expires_at = "2000-01-01";
    fetchMock.mockImplementationOnce(async () => {
      await disconnectWorkspace(s.db, "u1", "gmail");
      return json({ access_token: "late", expires_in: 3600 });
    });
    await expect(workspaceAccessToken(s.db, "u1", "gmail")).rejects.toThrow(
      "changed",
    );
    expect(s.tables.user_google_workspace_tokens).toHaveLength(0);
  });
  it("removes a revoked grant and returns a controlled error", async () => {
    const s = await connected();
    s.tables.user_google_workspace_tokens[0].expires_at = "2000-01-01";
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: "invalid_grant",
          error_description: "secret provider details",
        },
        400,
      ),
    );
    await expect(workspaceAccessToken(s.db, "u1", "gmail")).rejects.toThrow(
      "Reconnect",
    );
    expect(s.tables.user_google_workspace_tokens).toHaveLength(0);
  });
});

describe("Google action approval boundary", () => {
  it.each([
    ["gmail", false],
    ["google-calendar", false],
    ["gmail", true],
    ["google-calendar", true],
  ] as const)(
    "advertises accurate permission guidance for %s (writes: %s)",
    async (provider, write) => {
      const s = await connected(write, provider);
      const tools = (await buildGoogleWorkspaceTools("u1", s.db)) as Array<{
        function: { name: string; description: string };
      }>;
      expect(tools.length).toBeGreaterThan(0);
      expect(
        tools.some((tool) => tool.function.name.includes("_propose_")),
      ).toBe(write);
      for (const tool of tools) {
        expect(tool.function.description).toContain(
          "approval in the Assistant conversation",
        );
        if (write) {
          expect(tool.function.description).toContain(
            "Write access is enabled",
          );
          expect(tool.function.description).not.toContain(
            "connection is read-only",
          );
        } else {
          expect(tool.function.description).toContain(
            "connection is read-only",
          );
          expect(tool.function.description).toContain(
            "Manage → Enable writes with approval",
          );
          expect(tool.function.description).toContain(
            "user can do this themselves",
          );
        }
      }
    },
  );
  it("hides write tools by default and rejects fabricated direct calls including a model approval flag", async () => {
    const s = await connected();
    const tools = await buildGoogleWorkspaceTools("u1", s.db);
    expect(JSON.stringify(tools)).not.toContain("gmail_propose");
    const result = await executeGoogleWorkspaceToolCall(
      "u1",
      "gmail_propose_send",
      email,
      s.db,
    );
    expect(result.event.status).toBe("error");
    expect(s.tables.google_workspace_actions).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() =>
      parseWorkspaceTool("gmail_propose_send", { ...email, approved: true }),
    ).toThrow("Invalid");
  });
  it("only persists an encrypted proposal until approved, then sends exactly once", async () => {
    const s = await connected(true);
    const id = await proposal(s);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(s.tables.google_workspace_actions)).not.toContain(
      "recipient@example.com",
    );
    expect(await listWorkspaceActions(s.db, "u2")).toEqual([]);
    expect((await listWorkspaceActions(s.db, "u1"))[0].proposal.args).toEqual(
      email,
    );
    fetchMock.mockResolvedValueOnce(json({ id: "sent-id" }));
    const results = await Promise.allSettled([
      approveWorkspaceAction(s.db, "u1", id),
      approveWorkspaceAction(s.db, "u1", id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/messages/send");
    expect(s.tables.google_workspace_actions[0].status).toBe("succeeded");
  });
  it.each(["wrong-user", "expired", "rejected", "disconnected", "replaced"])(
    "blocks %s proposals without sending",
    async (kind) => {
      const s = await connected(true);
      const id = await proposal(s);
      if (kind === "expired")
        s.tables.google_workspace_actions[0].expires_at = "2000-01-01";
      if (kind === "rejected") await rejectWorkspaceAction(s.db, "u1", id);
      if (kind === "disconnected")
        await disconnectWorkspace(s.db, "u1", "gmail");
      if (kind === "replaced")
        s.tables.user_google_workspace_tokens[0].grant_id = "new";
      await expect(
        approveWorkspaceAction(s.db, kind === "wrong-user" ? "u2" : "u1", id),
      ).rejects.toThrow("proposal");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("keeps an uncertain send consumed instead of retrying it", async () => {
    const s = await connected(true);
    const id = await proposal(s);
    fetchMock.mockRejectedValueOnce(
      new Error("provider response lost with secret"),
    );
    expect(await approveWorkspaceAction(s.db, "u1", id)).toMatchObject({
      status: "uncertain",
    });
    await expect(approveWorkspaceAction(s.db, "u1", id)).rejects.toThrow(
      "proposal",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s.tables)).not.toContain("provider response lost");
  });
  it("does not call Google when the claim transaction fails", async () => {
    const s = await connected(true);
    const id = await proposal(s);
    s.failures.set("claim_google_workspace_action", new Error("database"));
    await expect(approveWorkspaceAction(s.db, "u1", id)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not replay when recording the outcome fails", async () => {
    const s = await connected(true);
    const id = await proposal(s);
    fetchMock.mockResolvedValueOnce(json({ id: "sent" }));
    s.failures.set(
      "google_workspace_actions:update",
      new Error("db write failed"),
    );
    await expect(approveWorkspaceAction(s.db, "u1", id)).rejects.toThrow(
      "will not run again",
    );
    await expect(approveWorkspaceAction(s.db, "u1", id)).rejects.toThrow(
      "proposal",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Gmail and Calendar API behavior", () => {
  it("reads MIME plain text, skips attachment bytes, and reports truncation", () => {
    const result = readableMessage(
      {
        id: "m",
        payload: {
          parts: [
            {
              mimeType: "text/plain",
              body: { data: Buffer.from("hello world").toString("base64url") },
            },
            {
              filename: "a.pdf",
              mimeType: "application/pdf",
              body: { attachmentId: "a", size: 20, data: "private" },
            },
          ],
        },
      },
      5,
    );
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(true);
    expect(result.attachments[0].filename).toBe("a.pdf");
    expect(result.attachmentContentsIncluded).toBe(false);
  });
  it("converts HTML to inert text without fetching remote resources", () => {
    expect(
      readableMessage({
        payload: {
          mimeType: "text/html",
          body: {
            data: Buffer.from(
              '<p>hello</p><img src="https://evil.test/tracker">',
            ).toString("base64url"),
          },
        },
      }).text,
    ).toContain("hello");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("encodes Gmail queries and pagination without changing endpoints", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ messages: [{ id: "m" }], nextPageToken: "next" }),
    );
    const result = await readWorkspaceTool(
      "gmail",
      "gmail_search",
      {
        query: "from:a@example.com & subject:hello",
        page_token: "next/+",
        max_results: 2,
      },
      "t",
    );
    expect(result).toMatchObject({ nextPageToken: "next" });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("q")).toBe(
      "from:a@example.com & subject:hello",
    );
    expect(url.searchParams.get("pageToken")).toBe("next/+");
    expect(url.hostname).toBe("gmail.googleapis.com");
  });
  it("rejects header injection, unsafe IDs, and unexpected fields", () => {
    expect(() =>
      parseWorkspaceTool("gmail_propose_send", {
        ...email,
        to: ["a@example.com\r\nBcc:b@example.com"],
      }),
    ).toThrow();
    expect(() =>
      parseWorkspaceTool("gmail_read_message", { message_id: ".." }),
    ).toThrow();
    expect(() =>
      parseWorkspaceTool("gmail_propose_send", {
        ...email,
        subject: "hello\r\nFrom:evil",
      }),
    ).toThrow();
  });
  it("encodes Unicode MIME without exposing Bcc as body text", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "sent" }));
    await executeWorkspaceAction(
      "gmail",
      {
        tool: "gmail_propose_send",
        args: {
          ...email,
          subject: "Résumé",
          body: "こんにちは",
          bcc: ["hidden@example.com"],
        },
      },
      "t",
    );
    const raw = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).raw;
    const mime = Buffer.from(raw, "base64url").toString();
    expect(mime).toContain("Bcc: hidden@example.com");
    expect(mime).toContain(Buffer.from("Résumé").toString("base64"));
    expect(mime).toContain(Buffer.from("こんにちは").toString("base64"));
  });
  it("captures the event version and uses If-Match; attendees are explicitly notified", async () => {
    const args = {
      calendar_id: "primary",
      event_id: "event",
      summary: "New title",
    };
    fetchMock.mockResolvedValueOnce(
      json({ id: "event", etag: '"v1"', summary: "Original" }),
    );
    const action = await prepareWorkspaceAction(
      "google-calendar",
      "google_calendar_propose_update",
      args,
      "t",
    );
    fetchMock.mockResolvedValueOnce(json({ id: "event" }));
    await executeWorkspaceAction("google-calendar", action, "t");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "PATCH",
      headers: { "If-Match": '"v1"' },
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain("sendUpdates=all");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      summary: "New title",
    });
  });
  it("rejects changed calendar versions and recurring series edits", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { message: "secret" } }, 412),
    );
    await expect(
      executeWorkspaceAction(
        "google-calendar",
        {
          tool: "google_calendar_propose_delete",
          args: { calendar_id: "primary", event_id: "e" },
          etag: "v1",
        },
        "t",
      ),
    ).rejects.toThrow("changed");
    fetchMock.mockResolvedValueOnce(
      json({ etag: "v1", recurrence: ["RRULE:FREQ=DAILY"] }),
    );
    await expect(
      prepareWorkspaceAction(
        "google-calendar",
        "google_calendar_propose_delete",
        { calendar_id: "primary", event_id: "e" },
        "t",
      ),
    ).rejects.toThrow("recurring series");
  });
  it("rejects invalid event intervals before any Google call", async () => {
    await expect(
      prepareWorkspaceAction(
        "google-calendar",
        "google_calendar_propose_create",
        { start: { date: "2026-09-25" }, end: { date: "2026-09-24" } },
        "t",
      ),
    ).rejects.toThrow("later");
    await expect(
      prepareWorkspaceAction(
        "google-calendar",
        "google_calendar_propose_create",
        { start: { date: "2026-02-30" }, end: { date: "2026-03-04" } },
        "t",
      ),
    ).rejects.toThrow("Invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("uses trash rather than permanent message deletion", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "m" }));
    await executeWorkspaceAction(
      "gmail",
      { tool: "gmail_propose_trash", args: { message_id: "m" } },
      "t",
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain("/messages/m/trash");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("POST");
  });
  it("all tools produce provider-compatible JSON schemas", () => {
    expect(WORKSPACE_TOOLS.length).toBeGreaterThan(10);
  });
});

describe("additional Google service regression coverage", () => {
  it("keeps broad returned scopes read-only unless the OAuth attempt opted into writes", async () => {
    const s = workspaceDb();
    const start = await startWorkspaceOAuth(
      s.db,
      "u1",
      "gmail",
      "https://mike.test",
    );
    fetchMock
      .mockResolvedValueOnce(
        json({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        }),
      )
      .mockResolvedValueOnce(
        json({
          email: "chosen@example.com",
          email_verified: true,
          sub: "chosen",
        }),
      );
    await completeWorkspaceOAuth(
      s.db,
      "u1",
      "gmail",
      new URL(start.authorizationUrl).searchParams.get("state")!,
      "code",
    );
    expect((await workspaceStatus(s.db, "u1", "gmail")).writeEnabled).toBe(
      false,
    );
    expect(
      JSON.stringify(await buildGoogleWorkspaceTools("u1", s.db)),
    ).not.toContain("gmail_propose");
  });
  it("uses the exact encrypted PKCE verifier and redirect, and rejects an unverified account", async () => {
    const s = workspaceDb();
    const started = await startWorkspaceOAuth(
      s.db,
      "u1",
      "gmail",
      "https://mike.test/api/callback",
    );
    const config = JSON.parse(
      decryptFields(s.tables.google_workspace_oauth_states[0], "state_config"),
    );
    fetchMock
      .mockImplementationOnce(async (_url, init) => {
        const body = init?.body as URLSearchParams;
        expect(body.get("code_verifier")).toBe(config.verifier);
        expect(body.get("redirect_uri")).toBe(config.redirectUri);
        expect(body.get("client_secret")).toBe("test-secret");
        return json({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
          scope: requiredScopes("gmail", false).join(" "),
        });
      })
      .mockResolvedValueOnce(
        json({
          email: "unverified@example.com",
          email_verified: false,
          sub: "other",
        }),
      );
    await expect(
      completeWorkspaceOAuth(
        s.db,
        "u1",
        "gmail",
        new URL(started.authorizationUrl).searchParams.get("state")!,
        "code",
      ),
    ).rejects.toThrow("verify");
    expect(s.tables.user_google_workspace_tokens).toHaveLength(0);
  });
  it("reports a missing migration separately from a disconnected account", async () => {
    const s = workspaceDb();
    s.failures.set("user_google_workspace_tokens:select", { code: "PGRST205" });
    expect(await workspaceStatus(s.db, "u1", "gmail")).toMatchObject({
      schemaReady: false,
      connected: false,
      configured: true,
    });
  });
  it.each([
    [
      "gmail",
      "gmail_list_drafts",
      { query: "subject:test" },
      { drafts: [{ id: "d" }] },
    ],
    ["gmail", "gmail_list_labels", {}, { labels: [{ id: "INBOX" }] }],
    [
      "gmail",
      "gmail_read_message",
      { message_id: "m" },
      {
        id: "m",
        payload: { mimeType: "text/plain", body: { data: "aGVsbG8" } },
      },
    ],
    [
      "gmail",
      "gmail_read_draft",
      { draft_id: "d" },
      { id: "d", message: { id: "m" } },
    ],
    [
      "gmail",
      "gmail_read_thread",
      { thread_id: "t" },
      { id: "t", messages: Array.from({ length: 22 }, () => ({ id: "m" })) },
    ],
    [
      "google-calendar",
      "google_calendar_list_calendars",
      {},
      { items: [{ id: "primary" }] },
    ],
    [
      "google-calendar",
      "google_calendar_list_events",
      {
        calendar_id: "a@example.com",
        time_min: "2026-09-22T00:00:00Z",
        time_max: "2026-09-23T00:00:00Z",
      },
      { items: [{ id: "e" }] },
    ],
    [
      "google-calendar",
      "google_calendar_read_event",
      { calendar_id: "primary", event_id: "e" },
      { id: "e" },
    ],
  ] as const)(
    "reads %s via %s without modifying Google",
    async (provider, name, args, result) => {
      fetchMock.mockResolvedValueOnce(json(result));
      const value = await readWorkspaceTool(provider, name, args, "token");
      expect(value).toBeDefined();
      expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
      if (name === "gmail_read_thread")
        expect(value).toMatchObject({ truncated: true });
    },
  );
  it.each(["gmail_propose_save_draft", "gmail_propose_delete_draft"] as const)(
    "prepares %s without modifying the draft and rejects stale versions",
    async (name) => {
      fetchMock.mockResolvedValueOnce(
        json({ id: "d", message: { id: "m", historyId: "h1" } }),
      );
      const action = await prepareWorkspaceAction(
        "gmail",
        name,
        name === "gmail_propose_save_draft"
          ? { ...email, draft_id: "d" }
          : { draft_id: "d" },
        "token",
      );
      expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
      fetchMock.mockResolvedValueOnce(
        json({ id: "d", message: { id: "m2", historyId: "h2" } }),
      );
      const mutation = vi.fn();
      await expect(
        executeWorkspaceAction("gmail", action, "token", mutation),
      ).rejects.toThrow("changed");
      expect(mutation).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["In-Reply-To", "References", "in-reply-to"])(
    "refuses replacement of reply drafts identified by %s",
    async (name) => {
      const draft = {
        id: "d",
        message: {
          id: "m",
          historyId: "h",
          payload: { headers: [{ name, value: "<original@example.com>" }] },
        },
      };
      fetchMock.mockResolvedValueOnce(json(draft));
      await expect(
        prepareWorkspaceAction(
          "gmail",
          "gmail_propose_save_draft",
          { ...email, draft_id: "d" },
          "token",
        ),
      ).rejects.toThrow("reply drafts");
      const mutate = vi.fn();
      fetchMock.mockResolvedValueOnce(json(draft));
      await expect(
        executeWorkspaceAction(
          "gmail",
          {
            tool: "gmail_propose_save_draft",
            args: { ...email, draft_id: "d" },
            before: { message: { id: "m", historyId: "h" } },
          },
          "token",
          mutate,
        ),
      ).rejects.toThrow("reply drafts");
      expect(mutate).not.toHaveBeenCalled();
    },
  );
  it("refuses attachment-bearing draft replacement", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        id: "d",
        message: {
          id: "m",
          payload: {
            parts: [{ filename: "contract.pdf", body: { attachmentId: "a" } }],
          },
        },
      }),
    );
    await expect(
      prepareWorkspaceAction(
        "gmail",
        "gmail_propose_save_draft",
        { ...email, draft_id: "d" },
        "token",
      ),
    ).rejects.toThrow("attachments");
  });
  it.each([
    ["gmail", "gmail_propose_save_draft", email, "POST", "/drafts"],
    [
      "gmail",
      "gmail_propose_modify",
      { message_id: "m", add_label_ids: ["UNREAD"], remove_label_ids: [] },
      "POST",
      "/messages/m/modify",
    ],
    [
      "google-calendar",
      "google_calendar_propose_create",
      {
        calendar_id: "primary",
        summary: "Meeting",
        start: { date: "2026-09-22" },
        end: { date: "2026-09-23" },
      },
      "POST",
      "/calendars/primary/events",
    ],
    [
      "google-calendar",
      "google_calendar_propose_delete",
      { calendar_id: "primary", event_id: "e" },
      "DELETE",
      "/calendars/primary/events/e",
    ],
  ] as const)(
    "executes the approved %s %s with the intended method",
    async (provider, name, args, method, path) => {
      fetchMock.mockResolvedValueOnce(
        json({}, method === "DELETE" ? 204 : 200),
      );
      const mutation = vi.fn();
      await executeWorkspaceAction(
        provider,
        { tool: name, args, etag: '"v1"' },
        "token",
        mutation,
      );
      expect(mutation).toHaveBeenCalledOnce();
      expect(new URL(String(fetchMock.mock.calls[0][0])).pathname).toContain(
        path,
      );
      expect(fetchMock.mock.calls[0][1]?.method).toBe(method);
    },
  );
  it("rejects special mail-state label manipulation and overlapping label changes", async () => {
    fetchMock.mockImplementation(async () => json({ id: "m" }));
    await expect(
      prepareWorkspaceAction(
        "gmail",
        "gmail_propose_modify",
        { message_id: "m", add_label_ids: ["TRASH"], remove_label_ids: [] },
        "t",
      ),
    ).rejects.toThrow("Trash proposal");
    await expect(
      prepareWorkspaceAction(
        "gmail",
        "gmail_propose_modify",
        {
          message_id: "m",
          add_label_ids: ["INBOX"],
          remove_label_ids: ["INBOX"],
        },
        "t",
      ),
    ).rejects.toThrow("non-overlapping");
  });
  it("includes the selected sender and folds long Unicode subjects into valid MIME words", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "sent" }));
    await executeWorkspaceAction(
      "gmail",
      {
        tool: "gmail_propose_send",
        accountEmail: "chosen@example.com",
        args: { ...email, subject: "😀".repeat(100) },
      },
      "t",
    );
    const raw = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).raw;
    const mime = Buffer.from(raw, "base64url").toString();
    expect(mime).toContain("From: chosen@example.com");
    for (const word of mime.match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? [])
      expect(word.length).toBeLessThanOrEqual(75);
  });
});
