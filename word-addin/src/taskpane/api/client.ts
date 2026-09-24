import type {
  ApiKeyStatus,
  Document,
  LibraryFolder,
  Project,
  Workflow,
} from "../types";

// Re-exported so existing imports keep working; the definition lives in
// ../types so cross-package type-only consumers (frontend/src/wordAddin
// parity tests) never pull this module, and its runtime imports, into
// the web app's type-check graph.
export type { ApiKeyStatus } from "../types";
import { networkFailure } from "../lib/networkError";
import { reportApiFailure, reportNetworkFailure } from "../lib/errorReporting";
import type { ReasoningLevel } from "../lib/wordChatTypes";
import {
  createControlRequestRetryPolicy,
  firstUploadResult,
  uploadFilesWithSessionCore,
  type UploadOutcome,
  type UploadProgress,
} from "@mike/upload-session-client";

export {
  UploadBatchError,
  failedUploadMessage,
} from "@mike/upload-session-client";
export type {
  UploadOutcome,
  UploadProgress,
} from "@mike/upload-session-client";

type AuthHeaderProvider = () => Promise<Record<string, string>>;

interface MikeApiClientConfig {
  baseUrl?: string;
  getAuthHeaders?: AuthHeaderProvider;
  fetchImpl?: typeof fetch;
}

interface ResolvedMikeApiClientConfig {
  baseUrl: string;
  getAuthHeaders: AuthHeaderProvider;
  fetchImpl: typeof fetch;
}

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>): void => {
  if (isDev) console.log(...args);
};

/**
 * A non-ok HTTP response. Carries everything the UI needs to classify the
 * failure (`status`, `code`) and everything support needs to find it in the
 * logs (`requestId`). `message` is only ever safe-to-show text: the
 * backend's own 4xx `detail`, or a generic line for 5xx.
 */
export class MikeApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(args: {
    message: string;
    status: number;
    code?: string | null;
    requestId?: string | null;
  }) {
    super(args.message);
    this.name = "MikeApiError";
    this.status = args.status;
    this.code = args.code ?? null;
    this.requestId = args.requestId ?? null;
  }
}

/**
 * A 5xx body is a stack trace, a proxy's HTML, or a provider's raw
 * complaint — never something written for a user. Replace it wholesale.
 */
const SERVER_ERROR_MESSAGE = "Something went wrong on our side. Try again.";

export interface ParsedApiError {
  message: string;
  code: string | null;
  requestId: string | null;
}

/**
 * Turn a non-ok response body into the fields the UI shows. Pure, so the
 * rules ("never echo a 5xx body", "keep the backend's 4xx detail") can be
 * checked without a server.
 *
 * `message` falls back to `API error: <status>`, which `describeError`
 * recognises as "no usable text" and replaces with its own wording.
 */
export function parseApiErrorBody(args: {
  status: number;
  body: string;
  requestId?: string | null;
}): ParsedApiError {
  const generic = `API error: ${args.status}`;
  let code: string | null = null;
  let requestId = args.requestId ?? null;
  let detail: string | null = null;

  try {
    const parsed = JSON.parse(args.body) as {
      detail?: unknown;
      code?: unknown;
      request_id?: unknown;
      error?: { code?: unknown; message?: unknown; request_id?: unknown };
    };
    code =
      typeof parsed.error?.code === "string"
        ? parsed.error.code
        : typeof parsed.code === "string"
          ? parsed.code
          : null;
    requestId =
      (typeof parsed.request_id === "string" ? parsed.request_id : null) ??
      (typeof parsed.error?.request_id === "string"
        ? parsed.error.request_id
        : null) ??
      requestId;
    detail =
      typeof parsed.error?.message === "string" && parsed.error.message
        ? parsed.error.message
        : typeof parsed.detail === "string" && parsed.detail
          ? parsed.detail
          : null;
  } catch {
    // A non-JSON body is a proxy or host page, never user-facing copy.
    detail = null;
  }

  return {
    // 4xx detail is written for users by the backend; 5xx text never is.
    message: args.status >= 500 ? SERVER_ERROR_MESSAGE : (detail ?? generic),
    code,
    requestId,
  };
}

let clientConfig: ResolvedMikeApiClientConfig = {
  baseUrl: "http://localhost:3001",
  getAuthHeaders: async () => ({}),
  // A wrapper keeps native fetch detached from the config object. Chromium
  // throws "Illegal invocation" when native fetch is called as a method.
  fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
};

export function configureMikeApiClient(config: MikeApiClientConfig): void {
  clientConfig = {
    baseUrl: config.baseUrl ?? clientConfig.baseUrl,
    getAuthHeaders: config.getAuthHeaders ?? clientConfig.getAuthHeaders,
    fetchImpl: config.fetchImpl ?? clientConfig.fetchImpl,
  };
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  return clientConfig.getAuthHeaders();
}

function apiUrl(path: string): string {
  return `${clientConfig.baseUrl}${path}`;
}

/**
 * Every request goes through here so a transport failure names the call that
 * failed instead of surfacing the host's bare "Load failed".
 */
async function sendRequest(
  url: string,
  init: RequestInit & { method?: string },
): Promise<Response> {
  try {
    return await clientConfig.fetchImpl(url, init);
  } catch (error) {
    // Preserve cancellation identity for callers and avoid reporting normal
    // user stops, including signals aborted with a custom reason.
    if (
      init.signal?.aborted ||
      (typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError")
    ) {
      throw error;
    }
    reportNetworkFailure(error, { method: init.method ?? "GET", url });
    throw networkFailure(error, { method: init.method ?? "GET", url });
  }
}

/**
 * Build the error for a non-ok response. Exported so every hand-rolled
 * fetch in the add-in (auth, word-chat) produces the same shape as the
 * typed client instead of a bespoke `new Error(status + body)`.
 */
export async function responseError(
  response: Response,
  path?: string,
  method = "GET",
): Promise<MikeApiError> {
  const text = await response.text().catch(() => "");
  const parsed = parseApiErrorBody({
    status: response.status,
    body: text,
    requestId: response.headers.get("x-request-id"),
  });
  devLog("[mike-api] non-ok response", {
    path: path ?? response.url,
    status: response.status,
    code: parsed.code,
    requestId: parsed.requestId,
    bodyPreview: text.slice(0, 200),
  });
  const apiError = new MikeApiError({
    status: response.status,
    code: parsed.code,
    requestId: parsed.requestId,
    message: parsed.message,
  });
  // A 5xx is the server's fault and worth an event; 4xx are user-facing
  // outcomes (validation, permission) and stay out of Sentry.
  if (response.status >= 500) {
    reportApiFailure({
      path: path ?? response.url,
      method,
      status: response.status,
      code: parsed.code,
      requestId: parsed.requestId,
      error: apiError,
    });
  }
  return apiError;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const authHeaders = await getAuthHeaders();
  const { headers: initHeaders, ...restInit } = init ?? {};
  const response = await sendRequest(apiUrl(path), {
    cache: "no-store",
    ...restInit,
    headers: {
      Accept: "application/json",
      ...authHeaders,
      ...(initHeaders as Record<string, string> | undefined),
    },
  });

  if (!response.ok) {
    throw await responseError(response, path, restInit.method ?? "GET");
  }
  if (
    response.status === 204 ||
    response.headers.get("content-length") === "0"
  ) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * Options every add-in upload entry point accepts, matching the web client so
 * a pane can follow progress and cancel a batch it no longer needs.
 */
export type UploadRequestOptions<T> = {
  onProgress?: (progress: UploadProgress<T>) => void;
  signal?: AbortSignal;
};

async function uploadSessionFiles<T>(args: {
  purpose:
    | "document_create"
    | "document_version_create"
    | "document_version_replace";
  destination: Record<string, unknown>;
  files: File[];
  onProgress?: (progress: UploadProgress<T>) => void;
  signal?: AbortSignal;
}): Promise<UploadOutcome<T>[]> {
  return uploadFilesWithSessionCore<T>({
    purpose: args.purpose,
    destination: args.destination,
    files: args.files.map((file) => ({ file })),
    onProgress: args.onProgress,
    signal: args.signal,
    transport: {
      apiRequest,
      fetchStorage: (...fetchArgs) => clientConfig.fetchImpl(...fetchArgs),
      shouldRetryControlRequest: createControlRequestRetryPolicy((error) =>
        error instanceof MikeApiError
          ? { status: error.status, code: error.code }
          : null,
      ),
    },
  });
}

export async function listProjects(pagination?: {
  limit?: number;
  offset?: number;
}): Promise<Project[]> {
  const params = new URLSearchParams({ view: "summary" });
  if (pagination?.limit != null) {
    params.set("limit", String(pagination.limit));
  }
  if (pagination?.offset != null) {
    params.set("offset", String(pagination.offset));
  }
  return apiRequest<Project[]>(`/projects?${params.toString()}`);
}

interface UserProfile {
  displayName: string | null;
  organisation: string | null;
  messageCreditsUsed: number;
  creditsResetDate: string;
  creditsRemaining: number;
  tier: string;
  titleModel: string | null;
  tabularModel: string | null;
  lastSelectedChatModel: string | null;
  lastSelectedReasoningLevel: ReasoningLevel;
  mfaOnLogin: boolean;
  legalResearchUs: boolean;
  openRouterModels: string[];
  vercelModels: string[];
  openCodeGoModels: string[];
  apiKeyStatus: ApiKeyStatus;
}

export async function getUserProfile(): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/profile");
}

export async function updateLastSelectedChatModel(
  model: string,
): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastSelectedChatModel: model }),
    keepalive: true,
  });
}

export async function updateLastSelectedReasoningLevel(
  reasoningLevel: ReasoningLevel,
): Promise<UserProfile> {
  return apiRequest<UserProfile>("/user/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lastSelectedReasoningLevel: reasoningLevel }),
    keepalive: true,
  });
}


export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
  return apiRequest<ApiKeyStatus>("/user/api-keys");
}

export async function uploadStandaloneDocument(
  file: File,
  options?: UploadRequestOptions<Document>,
): Promise<Document> {
  return firstUploadResult(await uploadStandaloneDocuments([file], options));
}

export async function uploadStandaloneDocuments(
  files: File[],
  options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
  return uploadSessionFiles<Document>({
    purpose: "document_create",
    destination: { scope: "standalone" },
    files,
    onProgress: options?.onProgress,
    signal: options?.signal,
  });
}

type LibraryKind = "files" | "templates";

interface LibraryCollection {
  documents: Document[];
  folders: LibraryFolder[];
  documentsHasMore?: boolean;
}

export async function getLibrary(
  kind: LibraryKind,
  pagination?: { limit?: number; offset?: number },
): Promise<LibraryCollection> {
  const params = new URLSearchParams();
  if (pagination?.limit != null) {
    params.set("limit", String(pagination.limit));
  }
  if (pagination?.offset != null) {
    params.set("offset", String(pagination.offset));
  }
  const query = params.toString();
  return apiRequest<LibraryCollection>(
    `/library/${kind}${query ? `?${query}` : ""}`,
  );
}

export async function getLibraryFolderChildren(
  kind: LibraryKind,
  folderId: string,
  pagination?: { limit?: number; offset?: number },
): Promise<LibraryCollection> {
  const params = new URLSearchParams({ parent_folder_id: folderId });
  if (pagination?.limit != null) {
    params.set("limit", String(pagination.limit));
  }
  if (pagination?.offset != null) {
    params.set("offset", String(pagination.offset));
  }
  return apiRequest<LibraryCollection>(`/library/${kind}?${params.toString()}`);
}

export async function getProjectDirectoryLevel(
  projectId: string,
  options?: {
    parentFolderId?: string | null;
    limit?: number;
    offset?: number;
  },
): Promise<LibraryCollection> {
  const params = new URLSearchParams();
  if (options?.parentFolderId) {
    params.set("parent_folder_id", options.parentFolderId);
  }
  if (options?.limit != null) params.set("limit", String(options.limit));
  if (options?.offset != null) params.set("offset", String(options.offset));
  return apiRequest<LibraryCollection>(
    `/projects/${projectId}/directory?${params.toString()}`,
  );
}

export async function streamWordChat(payload: {
  messages: {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
  }[];
  chat_id?: string;
  model?: string;
  reasoning?: ReasoningLevel;
  document_context?: string;
  document_id: string;
  document_name: string;
  storage: "cloud" | "local";
  edit_apply_mode: "direct" | "approval";
  /** Declares that this pane executes client_tool_call frames. */
  client_tools?: boolean;
  signal?: AbortSignal;
}): Promise<Response> {
  const { signal, ...body } = payload;
  const authHeaders = await getAuthHeaders();
  return sendRequest(apiUrl("/word-chat"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * Return channel for a client-executed tool call: posts the Office.js
 * outcome back to the backend tool loop that is awaiting it. 404 means the
 * call already expired (timeout or aborted stream) — callers should treat
 * that as a no-op, not a failure.
 */
export async function postWordChatToolResult(payload: {
  tool_call_id: string;
  result: unknown;
  signal?: AbortSignal;
}): Promise<void> {
  const { signal, ...body } = payload;
  await apiRequest<void>("/word-chat/tool-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/** Parse SSE data frames until the terminal `[DONE]` marker. */
export async function readSSE(
  response: Response,
  onEvent: (data: unknown) => void,
  options?: { signal?: AbortSignal },
): Promise<{ done: boolean }> {
  if (!response.body) {
    throw new Error("Response body is null — streaming not supported");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let cancellation: Promise<void> | null = null;
  const cancel = async (): Promise<void> => {
    cancellation ??= reader.cancel().catch(() => undefined);
    await cancellation;
  };

  const signal = options?.signal;
  const onAbort = (): void => {
    void cancel();
  };
  signal?.addEventListener("abort", onAbort);

  const processLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Ignore malformed transport noise rather than ending the stream.
      return false;
    }
    // Callback failures are application errors, not malformed SSE. Let
    // them propagate so callers cannot silently lose a valid event.
    onEvent(parsed);
    return false;
  };

  try {
    if (signal?.aborted) return { done: false };
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) return { done: false };
      if (done) {
        buffer += decoder.decode();
        const lines = buffer.split("\n");
        return { done: lines.some(processLine) };
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (signal?.aborted) return { done: false };
        if (processLine(line)) return { done: true };
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await cancel();
  }
}

type WorkflowType = Workflow["metadata"]["type"];

export async function listQuickActions(): Promise<
  import("../types").QuickAction[]
> {
  return apiRequest<import("../types").QuickAction[]>(
    "/quick-actions?surface=word",
  );
}

export async function updateQuickAction(
  quickActionId: string,
  payload: {
    workflow_id?: string;
    name?: string;
    prompt?: string;
    document_upload?: boolean;
    surface?: import("../types").QuickAction["surface"];
    enabled?: boolean;
    sort_order?: number;
  },
): Promise<import("../types").QuickAction> {
  return apiRequest<import("../types").QuickAction>(
    `/quick-actions/${quickActionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function createQuickAction(payload: {
  workflow_id: string;
  name: string;
  prompt: string;
  document_upload: boolean;
  surface: import("../types").QuickAction["surface"];
  enabled?: boolean;
  sort_order?: number;
}): Promise<import("../types").QuickAction> {
  return apiRequest<import("../types").QuickAction>("/quick-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function listWorkflowAssets(
  workflowId: string,
): Promise<Document[]> {
  return apiRequest<Document[]>(`/workflows/${workflowId}/assets`);
}

export async function uploadWorkflowAsset(
  workflowId: string,
  file: File,
  options?: UploadRequestOptions<Document>,
): Promise<Document> {
  return firstUploadResult(
    await uploadWorkflowAssets(workflowId, [file], options),
  );
}

export async function uploadWorkflowAssets(
  workflowId: string,
  files: File[],
  options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
  return uploadSessionFiles<Document>({
    purpose: "document_create",
    destination: { scope: "workflow", workflow_id: workflowId },
    files,
    onProgress: options?.onProgress,
    signal: options?.signal,
  });
}

export async function uploadWorkflowAssetVersion(
  assetId: string,
  file: File,
  options?: UploadRequestOptions<unknown>,
): Promise<unknown> {
  return firstUploadResult(
    await uploadSessionFiles<unknown>({
      purpose: "document_version_create",
      destination: { document_id: assetId, filename: file.name },
      files: [file],
      onProgress: options?.onProgress,
      signal: options?.signal,
    }),
  );
}

export async function getWorkflowAssetUrl(
  assetId: string,
): Promise<{ url: string; filename: string }> {
  return apiRequest<{ url: string; filename: string }>(
    `/single-documents/${assetId}/url`,
  );
}

export async function deleteWorkflowAsset(
  workflowId: string,
  assetId: string,
): Promise<void> {
  await apiRequest(`/workflows/${workflowId}/assets/${assetId}`, {
    method: "DELETE",
  });
}

export async function listWorkflows(type: WorkflowType): Promise<Workflow[]> {
  return apiRequest<Workflow[]>(`/workflows?type=${type}`);
}

export async function createWorkflow(payload: {
  metadata: {
    title: string;
    type: "assistant" | "tabular";
    language?: string | null;
    practice?: string | null;
    jurisdictions?: string[] | null;
  };
  skill_md?: string;
  columns_config?: { index: number; name: string; prompt: string }[];
}): Promise<Workflow> {
  return apiRequest<Workflow>("/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updateWorkflow(
  workflowId: string,
  payload: {
    metadata?: {
      title?: string;
      language?: string | null;
      practice?: string | null;
      jurisdictions?: string[] | null;
    };
    skill_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
  },
): Promise<Workflow> {
  return apiRequest<Workflow>(`/workflows/${workflowId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  await apiRequest(`/workflows/${workflowId}`, {
    method: "DELETE",
  });
}
