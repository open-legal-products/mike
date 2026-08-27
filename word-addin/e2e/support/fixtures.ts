/**
 * Shared Playwright fixture for the Mike Word add-in E2E suite.
 *
 * Spec authors import `{ test, expect }` from this module and drive the task
 * pane through the typed `addin` fixture — they should NEVER need to touch the
 * Office.js shim, page.route globs, or the static server. Everything is
 * hermetic: no live backend is ever contacted.
 *
 *   import { test, expect } from "./support/fixtures";
 *
 *   test("...", async ({ addin, page }) => {
 *     addin.seedToken("session");             // (optional) mock a cookie session
 *     await addin.mockApiJson("GET", "**\/projects", [{ id: "1", name: "X" }]);
 *     await addin.gotoTaskpane({ documentText: "Hello" });
 *     ...
 *   });
 *
 * Network mocks may be registered before OR after gotoTaskpane(); they apply to
 * any matching request that fires afterwards (logins/sends happen on click).
 * Seed setters affecting the initial mount must be called before
 * gotoTaskpane().
 */
import { test as base, expect, Page } from "@playwright/test";
import {
  installOfficeMock,
  OfficeSeed,
  WordCalls,
  WordDocumentSnapshot,
} from "./office-mock";

/** Static path the production bundle is served at (see playwright.config.ts). */
const TASKPANE_PATH = "/taskpane.html";

/** Block the real Office.js CDN so the shim stays authoritative. */
const OFFICE_JS_GLOB = "https://appsforoffice.microsoft.com/**";

// Route globs for every endpoint the add-in calls. Host-agnostic on purpose so
// they match regardless of REACT_APP_* build values.
const AUTH_GLOB = "**/auth/login";
const CHAT_GLOB = "**/word-chat";

type HttpMethod = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";

interface MockLoginOk {
  ok: true;
  /** Opaque marker for the mocked server session; never returned to the client. */
  accessToken?: string;
}
interface MockLoginError {
  /** Surfaced by LoginPage as the error message. */
  error: string;
  /** HTTP status for the failed grant (default 400). */
  status?: number;
}
type MockLoginArg = MockLoginOk | MockLoginError;

interface ChatStreamOpts {
  /** Emit a `{"type":"error","message"}` event BEFORE `[DONE]` (surfaces as a throw). */
  errorBefore?: string;
  /** Return a non-2xx HTTP response instead of a stream (>=400 triggers the failure path). */
  status?: number;
  /** Hold the response until the returned controller's release() is called. */
  deferred?: boolean;
  /** Stable chat identity emitted in the leading `chat_id` SSE event. */
  chatId?: string;
  /** Stable assistant-message UUID used to persist Word edit anchors. */
  assistantMessageId?: string;
  /** Emit model-triggered read start/completion frames before answer content. */
  docReads?: string[];
  /**
   * Emit `client_tool_call` frames (backend-forwarded Word tool calls) before
   * the answer content. The pane executes each with the Office shim and POSTs
   * its outcome to /word-chat/tool-result — specs must mock that endpoint.
   */
  clientToolCalls?: {
    toolCallId: string;
    name: string;
    input: Record<string, unknown>;
  }[];
  /** Emit a final `citations` frame (the quotes behind `[n]` markers). */
  citations?: unknown[];
}

interface MockJsonOpts {
  /** HTTP status for the response (default 200). */
  status?: number;
}

export interface Addin {
  /** The underlying Playwright page (escape hatch for custom assertions). */
  page: Page;

  // ----- seeding (call BEFORE gotoTaskpane) -----
  /** Start with a mocked server-side cookie session. */
  seedToken(token: string): void;
  /** Pre-seed legacy refresh-token storage to test migration cleanup. */
  seedRefreshToken(token: string): void;

  // ----- navigation -----
  /**
   * Install the Office.js shim with the accumulated seed (merged with `opts`),
   * navigate to the task pane, and wait for React to mount (login OR app shell).
   */
  gotoTaskpane(opts?: OfficeSeed): Promise<void>;
  /** Reload the task pane while preserving the open mock Word document. */
  reloadTaskpane(): Promise<void>;
  /** Assert the authenticated floating chat shell is showing. */
  expectAuthedShell(): Promise<void>;

  // ----- reads -----
  /** Read legacy `mike_token` storage (must remain null after initialization). */
  getToken(): Promise<string | null>;
  /** Read legacy refresh-token storage (must remain null after initialization). */
  getRefreshToken(): Promise<string | null>;
  /** Read the recorded write-side Word calls for assertions. */
  wordCalls(): Promise<WordCalls>;
  /** Inspect bookmarks and add-in settings saved inside the mock document. */
  wordDocument(): Promise<WordDocumentSnapshot>;
  /** Replace a setting in the open mock document and its active settings copy. */
  setWordDocumentSetting(key: string, value: unknown): Promise<void>;
  /** Remove a setting from the open mock document and its active settings copy. */
  removeWordDocumentSetting(key: string): Promise<void>;
  /** Simulate accepting/rejecting a bookmarked revision directly in Word. */
  resolveBookmarkExternally(
    bookmarkName: string,
    decision: "accepted" | "rejected",
  ): Promise<boolean>;
  /** Add an unrelated pending revision inside an existing bookmark range. */
  injectRevisionIntoBookmark(
    bookmarkName: string,
    type: "Added" | "Deleted",
    text: string,
  ): Promise<boolean>;

  // ----- network mocks -----
  /** Mock the backend login endpoint: success ({ ok }) or failure ({ error }). */
  mockLogin(arg: MockLoginArg): Promise<void>;
  /**
   * Mock the `/word-chat` SSE stream. Emits one `content_delta` per chunk, then
   * `[DONE]`. `opts.errorBefore` injects a pre-`[DONE]` error event;
   * `opts.status` (>=400) returns an HTTP failure instead.
   */
  mockChatStream(
    chunks: string[],
    opts?: ChatStreamOpts,
  ): Promise<{ release: () => void }>;
  /** Mock any Mike API endpoint returning JSON for the given METHOD + URL glob. */
  mockApiJson(
    method: HttpMethod,
    urlGlob: string,
    json: unknown,
    opts?: MockJsonOpts,
  ): Promise<void>;
  /** Mock any Mike API endpoint returning an error status for METHOD + URL glob. */
  mockApiError(
    method: HttpMethod,
    urlGlob: string,
    status: number,
    message?: string,
  ): Promise<void>;
  /** Mock a successful direct-upload session for one standalone document. */
  mockStandaloneDocumentUpload(document: Record<string, unknown>): Promise<void>;
}

export const test = base.extend<{ addin: Addin }>({
  addin: async ({ page }, use) => {
    let seed: OfficeSeed = {};

    // Neutralise the CDN Office.js so only the shim defines the globals.
    await page.route(OFFICE_JS_GLOB, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: "/* office.js stubbed for E2E */",
      }),
    );

    // Fail closed: API requests not explicitly mocked by the fixture or a spec
    // must never escape to a developer's backend or Supabase project. Static
    // task-pane assets are the only network traffic allowed through.
    await page.route("**/*", (route, request) => {
      const url = new URL(request.url());
      if (
        (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
        url.port === "3100"
      ) {
        return route.fallback();
      }
      if (url.hostname === "appsforoffice.microsoft.com") {
        return route.fallback();
      }
      return route.abort("blockedbyclient");
    });

    await page.route("**/auth/session", (route, request) => {
      if (request.method() !== "GET") return route.fallback();
      if (!seed.token) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Invalid or expired session" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "test-user-id",
            email: "e2e@mike.local",
            pendingEmail: null,
            createdWithGoogle: false,
          },
        }),
      });
    });

    await page.route("**/auth/logout", (route, request) => {
      if (request.method() !== "POST") return route.fallback();
      seed.token = undefined;
      seed.refreshToken = undefined;
      return route.fulfill({ status: 204, body: "" });
    });

    await page.route("**/auth/handoff", async (route, request) => {
      if (request.method() !== "POST") return route.fallback();
      const body = request.postDataJSON() as {
        ticket?: unknown;
        requestId?: unknown;
      };
      if (
        typeof body.ticket !== "string" ||
        !/^[A-Za-z0-9_-]{32,256}$/.test(body.ticket) ||
        typeof body.requestId !== "string" ||
        body.requestId.length < 16
      ) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Invalid authentication handoff" }),
        });
      }
      seed.token = "google-cookie-session";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "test-user-id",
            email: "e2e@mike.local",
            pendingEmail: null,
            createdWithGoogle: true,
          },
        }),
      });
    });

    // Default the API-key status probe (fired on every authed mount by
    // ApiKeyBanner) to "claude configured" so the banner stays out of
    // unrelated specs — and so the request never escapes to a real backend,
    // where a 401 would clear the seeded session mid-test. Playwright matches
    // routes newest-first, so a spec's own mockApiJson/mockApiError for this
    // URL overrides it.
    await page.route("**/user/api-keys", (route, request) => {
      if (request.method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          claude: true,
          gemini: true,
          openai: true,
          openrouter: false,
          courtlistener: false,
          sources: {
            claude: "env",
            gemini: null,
            openai: null,
            openrouter: null,
            courtlistener: null,
          },
        }),
      });
    });

    // The composer model toggle probes local Ollama models on mount. Keep the
    // default hermetic and let specs override this route when testing locals.
    await page.route("**/models/ollama", (route, request) => {
      if (request.method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: [] }),
      });
    });

    // Empty-chat InitialView greeting. Keep profile reads deterministic and
    // hermetic while allowing a spec to override this route newest-first.
    await page.route("**/user/profile", (route, request) => {
      if (request.method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          displayName: "Test User",
          lastSelectedChatModel: "gemini-3-flash-preview",
          lastSelectedReasoningLevel: "high",
          openRouterModels: [],
          vercelModels: [],
          openCodeGoModels: [],
        }),
      });
    });

    let quickActions = [
      {
        id: "qa-proofread",
        workflow_id: "wf-proofread",
        name: "Proofread agreement",
        prompt:
          "Review the current document for drafting quality, internal consistency, grammar, punctuation, formatting, numbering, defined terms, and cross-reference errors. List each issue with its location, severity, and a specific recommended fix.",
        document_upload: false,
        surface: "word",
        enabled: true,
        sort_order: 0,
        workflow: { id: "wf-proofread", title: "Proofread" },
      },
      {
        id: "qa-extract",
        workflow_id: "wf-extract",
        name: "Extract key terms",
        prompt:
          "Extract the key legal, commercial, and operational terms from the current document. Present them in a concise table with the term, value, location, and notes, and flag material omissions or ambiguities without inventing missing information.",
        document_upload: false,
        surface: "word",
        enabled: true,
        sort_order: 1,
        workflow: { id: "wf-extract", title: "Extract Key Terms" },
      },
      {
        id: "qa-draft",
        workflow_id: "wf-draft",
        name: "Draft from template",
        prompt:
          "Create a completed draft from the template I attach, using the current document and any additional materials as source context. Preserve the template's formatting and structure, replace placeholders consistently, and ask for any essential missing information.",
        document_upload: false,
        surface: "word",
        enabled: true,
        sort_order: 2,
        workflow: { id: "wf-draft", title: "Draft From Template" },
      },
    ];
    await page.route("**/quick-actions**", async (route, request) => {
      if (request.method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(quickActions),
        });
      }
      if (request.method() === "PATCH") {
        const id = request.url().split("/").pop();
        const changes = request.postDataJSON() as Record<string, unknown>;
        quickActions = quickActions.map((action) =>
          action.id === id ? { ...action, ...changes } : action,
        );
        const updated = quickActions.find((action) => action.id === id);
        return route.fulfill({
          status: updated ? 200 : 404,
          contentType: "application/json",
          body: JSON.stringify(updated ?? { detail: "Not found" }),
        });
      }
      return route.fallback();
    });

    // Chat history preloads on every authenticated Assistant mount. Keep that
    // eager GET hermetic so unrelated specs never leak to a developer's live
    // backend (where a 401 can clear the seeded test session). History specs
    // register their own route later and therefore override this default.
    await page.route("**/word-chat?*", (route, request) => {
      if (request.method() !== "GET") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    });

    // Normalized edit rows persist independently from the streamed assistant
    // response. Keep those writes hermetic by default; storage specs can
    // register a newer route when asserting a payload.
    await page.route("**/word-chat/messages/*/edits/*?*", (route, request) => {
      if (request.method() === "PATCH") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "{}",
        });
      }
      if (request.method() !== "PUT") return route.fallback();
      const body = request.postDataJSON() as {
        original_text: string;
        replacement_text: string;
        formats?: string[];
        occurrence?: "all" | null;
        reason?: string | null;
        apply_mode: "direct" | "approval";
      };
      const url = new URL(request.url());
      const match = url.pathname.match(/\/messages\/([^/]+)\/edits\/(\d+)$/);
      const messageId = decodeURIComponent(match?.[1] ?? "assistant-message");
      const blockIndex = Number(match?.[2] ?? 0);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: `${messageId}:edit-${blockIndex}`,
          word_chat_message_id: messageId,
          block_index: blockIndex,
          original_text: body.original_text,
          replacement_text: body.replacement_text,
          formats: body.formats ?? [],
          occurrence: body.occurrence ?? null,
          reason: body.reason ?? null,
          apply_mode: body.apply_mode,
          apply_status: "proposed",
          resolution_status: null,
        }),
      });
    });

    /** Add a method-scoped JSON route; falls through to other routes on mismatch. */
    const routeJson = async (
      method: HttpMethod,
      glob: string,
      status: number,
      body: unknown,
    ) => {
      await page.route(glob, (route, request) => {
        if (request.method().toUpperCase() !== method) return route.fallback();
        return route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      });
    };

    const addin: Addin = {
      page,

      seedToken(token) {
        seed.token = token;
      },
      seedRefreshToken(token) {
        seed.refreshToken = token;
      },
      async gotoTaskpane(opts) {
        seed = { ...seed, ...(opts ?? {}) };
        await page.addInitScript(installOfficeMock, seed);
        await page.goto(TASKPANE_PATH);
        // Resolve once React has mounted past the loading spinner into either
        // the login gate or the authenticated floating shell.
        await expect(
          page.getByRole("button", { name: /^(Log in|Open menu)$/ }).first(),
        ).toBeVisible({
          timeout: 15_000,
        });
      },

      async expectAuthedShell() {
        await expect(
          page.getByRole("button", { name: "Open menu" }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "New chat" }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Chat history" }),
        ).toBeVisible();
      },

      async getToken() {
        return page.evaluate(() =>
          (
            window as unknown as {
              OfficeRuntime: {
                storage: { getItem(k: string): Promise<string | null> };
              };
            }
          ).OfficeRuntime.storage.getItem("mike_token"),
        );
      },

      async reloadTaskpane() {
        await page.reload();
        await expect(
          page.getByRole("button", { name: /^(Log in|Open menu)$/ }).first(),
        ).toBeVisible({ timeout: 15_000 });
      },

      async getRefreshToken() {
        return page.evaluate(() =>
          (
            window as unknown as {
              OfficeRuntime: {
                storage: { getItem(k: string): Promise<string | null> };
              };
            }
          ).OfficeRuntime.storage.getItem("mike_refresh_token"),
        );
      },

      async wordCalls() {
        return page.evaluate(
          () =>
            (window as unknown as { __WORD_CALLS__: WordCalls }).__WORD_CALLS__,
        );
      },

      async wordDocument() {
        return page.evaluate(() =>
          (
            window as unknown as {
              __WORD_TEST__: { snapshotDocument(): WordDocumentSnapshot };
            }
          ).__WORD_TEST__.snapshotDocument(),
        );
      },

      async setWordDocumentSetting(key, value) {
        await page.evaluate(
          ({ settingKey, settingValue }) => {
            (
              window as unknown as {
                __WORD_TEST__: {
                  setSetting(key: string, value: unknown): void;
                };
              }
            ).__WORD_TEST__.setSetting(settingKey, settingValue);
          },
          { settingKey: key, settingValue: value },
        );
      },

      async removeWordDocumentSetting(key) {
        await page.evaluate((settingKey) => {
          (
            window as unknown as {
              __WORD_TEST__: { removeSetting(key: string): void };
            }
          ).__WORD_TEST__.removeSetting(settingKey);
        }, key);
      },

      async resolveBookmarkExternally(bookmarkName, decision) {
        return page.evaluate(
          ({ name, resolution }) =>
            (
              window as unknown as {
                __WORD_TEST__: {
                  resolveBookmarkExternally(
                    bookmarkName: string,
                    decision: "accepted" | "rejected",
                  ): boolean;
                };
              }
            ).__WORD_TEST__.resolveBookmarkExternally(name, resolution),
          { name: bookmarkName, resolution: decision },
        );
      },

      async injectRevisionIntoBookmark(bookmarkName, type, text) {
        return page.evaluate(
          ({ name, revisionType, revisionText }) =>
            (
              window as unknown as {
                __WORD_TEST__: {
                  injectRevisionIntoBookmark(
                    bookmarkName: string,
                    type: "Added" | "Deleted",
                    text: string,
                  ): boolean;
                };
              }
            ).__WORD_TEST__.injectRevisionIntoBookmark(
              name,
              revisionType,
              revisionText,
            ),
          { name: bookmarkName, revisionType: type, revisionText: text },
        );
      },

      async mockLogin(arg) {
        await page.route(AUTH_GLOB, (route) => {
          if ("ok" in arg && arg.ok) {
            seed.token = arg.accessToken ?? "authenticated";
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                user: {
                  id: "test-user-id",
                  email: "e2e@mike.local",
                  pendingEmail: null,
                  createdWithGoogle: false,
                },
              }),
            });
          }
          const err = arg as MockLoginError;
          return route.fulfill({
            status: err.status ?? 400,
            contentType: "application/json",
            body: JSON.stringify({
              code: "invalid_credentials",
              detail: err.error,
            }),
          });
        });
      },

      async mockChatStream(chunks, opts) {
        let releaseResponse = (): void => undefined;
        const responseGate = new Promise<void>((resolve) => {
          releaseResponse = resolve;
        });
        await page.route(CHAT_GLOB, async (route, request) => {
          if (request.method() !== "POST") return route.fallback();
          if (opts?.status && opts.status >= 400) {
            return route.fulfill({
              status: opts.status,
              contentType: "text/plain",
              body: "chat request failed",
            });
          }
          if (opts?.deferred) await responseGate;
          let body = "";
          if (opts?.chatId || opts?.assistantMessageId) {
            body += `data: ${JSON.stringify({
              type: "chat_id",
              ...(opts.chatId ? { chatId: opts.chatId } : {}),
              ...(opts.assistantMessageId
                ? { assistantMessageId: opts.assistantMessageId }
                : {}),
            })}\n\n`;
          }
          for (const filename of opts?.docReads ?? []) {
            body += `data: ${JSON.stringify({
              type: "doc_read_start",
              filename,
            })}\n\n`;
            body += `data: ${JSON.stringify({
              type: "doc_read",
              filename,
            })}\n\n`;
          }
          for (const call of opts?.clientToolCalls ?? []) {
            body += `data: ${JSON.stringify({
              type: "client_tool_call",
              tool_call_id: call.toolCallId,
              name: call.name,
              input: call.input,
            })}\n\n`;
          }
          for (const chunk of chunks) {
            body += `data: ${JSON.stringify({
              type: "content_delta",
              text: chunk,
            })}\n\n`;
          }
          if (opts?.citations) {
            body += `data: ${JSON.stringify({
              type: "citations",
              status: "final",
              citations: opts.citations,
            })}\n\n`;
          }
          if (opts?.errorBefore) {
            body += `data: ${JSON.stringify({
              type: "error",
              message: opts.errorBefore,
            })}\n\n`;
          }
          body += "data: [DONE]\n\n";
          return route.fulfill({
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
            body,
          });
        });
        return { release: releaseResponse };
      },

      async mockApiJson(method, urlGlob, json, opts) {
        await routeJson(method, urlGlob, opts?.status ?? 200, json);
      },

      async mockApiError(method, urlGlob, status, message) {
        await routeJson(method, urlGlob, status, {
          error: message ?? `${status} error`,
        });
      },

      async mockStandaloneDocumentUpload(document) {
        const sessionId = "e2e-upload-session";
        let clientId = "e2e-upload-file";
        let filename = String(document.filename ?? "document.pdf");

        await page.route("**/upload-sessions", async (route, request) => {
          if (request.method() !== "POST") return route.fallback();
          const body = request.postDataJSON() as {
            files?: Array<{ client_id?: string; filename?: string }>;
          };
          clientId = body.files?.[0]?.client_id ?? clientId;
          filename = body.files?.[0]?.filename ?? filename;
          return route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              session: { id: sessionId, status: "pending_upload" },
              files: [
                {
                  id: clientId,
                  client_id: clientId,
                  filename,
                  status: "pending_upload",
                  error_code: null,
                  result: null,
                  upload: {
                    method: "PUT",
                    url: `https://storage.test/${clientId}`,
                    headers: {},
                  },
                },
              ],
            }),
          });
        });
        await page.route("https://storage.test/**", (route, request) => {
          if (request.method() !== "PUT") return route.fallback();
          return route.fulfill({ status: 200, body: "" });
        });
        await page.route(
          `**/upload-sessions/${sessionId}/files/*/complete`,
          (route, request) => {
            if (request.method() !== "POST") return route.fallback();
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                session: { id: sessionId, status: "processing" },
                files: [
                  {
                    id: clientId,
                    client_id: clientId,
                    filename,
                    status: "processing",
                    error_code: null,
                    result: null,
                  },
                ],
              }),
            });
          },
        );
        await page.route(`**/upload-sessions/${sessionId}`, (route, request) => {
          if (request.method() !== "GET") return route.fallback();
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              session: { id: sessionId, status: "completed" },
              files: [
                {
                  id: clientId,
                  client_id: clientId,
                  filename,
                  status: "completed",
                  error_code: null,
                  result: document,
                },
              ],
            }),
          });
        });
      },
    };

    await use(addin);
  },
});

export { expect };
export type { WordBookmarkSnapshot } from "./office-mock";
