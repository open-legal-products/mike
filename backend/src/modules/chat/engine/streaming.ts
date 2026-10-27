import { teamOrgIdOf } from "../../../lib/personalOrgs";
import { webSearchAccountFor, type WebSearchPlan } from "../../../lib/webSearch";
import { buildGoogleWorkspaceTools } from "../../../lib/integrations/googleWorkspace";
import {
  streamChatWithTools,
  resolveModel,
  type LlmMessage,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type OpenAIToolSchema,
  type TokenUsage,
} from "../../../lib/llm";
import { resolveRequestedModel } from "../../../lib/routerModels";
import {
  resolveEffectiveChatModel,
  sameProviderModels,
} from "../../../lib/modelSelection";
import { UserFacingError } from "../../../lib/userFacingError";
import { InvalidApiKeyError } from "../../../lib/llm/apiKeyErrors";
import { reportError } from "../../../lib/observability/sentry";
import { safeError } from "../../../lib/safeError";
import type { Db } from "../../../lib/supabase";
import { buildUserMcpTools } from "../../../lib/mcpConnectors";
import { buildGoogleDriveTools } from "../../../lib/integrations/googleDrive";
import { COURTLISTENER_TOOLS } from "./tools/courtlistenerTools";
import { createProviderWebSearchTracker } from "./tools/providerWebSearch";
import {
  MIKE_WEB_SEARCH_SYSTEM_PROMPT,
  PROVIDER_WEB_READ_SYSTEM_PROMPT,
  WEB_SEARCH_SYSTEM_PROMPT,
  WEB_TOOL_NAMES,
  createWebTurnState,
  runWebToolCall,
  webToolErrorMessage,
  webToolsFor,
  type WebTurnState,
} from "./tools/webSearchTools";
import {
  ASK_PARENT_TOOL,
  ASK_PARENT_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  SUBAGENT_EXCLUDED_TOOL_NAMES,
  createDelegateTurnState,
  delegateSystemPrompt,
  delegateTool,
  runDelegateCall,
  type DelegateContext,
  type DelegateResult,
  type SubagentDefaults,
} from "./tools/delegateTools";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type ToolCall,
  devLog,
  resolveDocLabel,
  TOOL_ERROR_MESSAGE,
} from "./types";
import {
  PLAYBOOK_TOOLS,
  TOOLS,
  WORKFLOW_TOOLS,
  isDocumentMutatingTool,
  toolName,
  withoutDocumentMutatingTools,
} from "./tools/toolSchemas";
import {
  parseCitationsWithDiagnostics,
  parsePartialCitationObjects,
  createCitation,
  CITATIONS_OPEN_TAG,
} from "./citations";
import { runToolCalls } from "./tools/toolDispatcher";
import {
  VISUAL_TOOL_NAMES,
  createVisualTurnState,
  visualTools,
  visualsSystemPrompt,
} from "./tools/visualTools";
import {
  VISUAL_BUILDER_TOOL_NAMES,
  runVisualBuild,
  type VisualBuilder,
} from "./tools/visualBuilder";
import {
  CODE_ANALYSIS_SYSTEM_PROMPT,
  PYTHON_TOOL_NAME,
  createChildPythonTurnState,
  createPythonTurnState,
  pythonRunErrorMessage,
  pythonToolsFor,
  type PythonTurnState,
} from "./tools/pythonTools";
import { addApprovalItems } from "./tools/connectorApprovals";
import { createKeyedLock, type KeyedLock } from "./tools/documentLocks";
import type { SubagentRunStore } from "./tools/delegateRuns";
import { documentSearchError } from "./tools/documentSearchErrors";
import {
  getCachedCaseOpinionTexts,
  type CourtlistenerTurnState,
} from "./tools/courtlistenerTurnState";
import {
  readDocumentContent,
  type TurnEditState,
  type TurnReadState,
} from "./tools/documentOps";
import { verifyCitations } from "./verifyCitations";
import { buildMemoryTurn } from "../../../lib/memory/prompt";

export type { AssistantEvent } from "@mike/contracts";
import type { AssistantEvent, AssistantErrorCode, DelegationEvent } from "@mike/contracts";

/**
 * Tools the model can call that execute outside this process — in the Word
 * task pane. The adapter owns forwarding the call to the client and awaiting
 * its posted result; the loop treats the returned content exactly like a
 * server-side tool result.
 */
export interface ClientToolsAdapter {
  schemas: OpenAIToolSchema[];
  owns: (name: string) => boolean;
  execute: (
    call: import("../../../lib/llm").NormalizedToolCall,
  ) => Promise<{ content: string; events: AssistantEvent[] }>;
}

export class AssistantStreamError extends Error {
  fullText: string;
  events: AssistantEvent[];

  constructor(
    message: string,
    fullText: string,
    events: AssistantEvent[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AssistantStreamError";
    this.fullText = fullText;
    this.events = events;
  }
}

export const ASSISTANT_ERROR_MESSAGE =
  "The response could not be completed. Please try again.";

/**
 * What to tell the client about a failed stream.
 *
 * The engine already decided whether a failure is safe to show (a rejected API
 * key, an unavailable model) and tagged it on the error event. Every streaming
 * route has to forward that verdict rather than flattening to "try again",
 * which sends the user to retry something that cannot succeed — so the choice
 * lives here once instead of in each route's catch.
 */
export function assistantStreamErrorPayload(error: unknown): {
  message: string;
  safe_to_display?: true;
  code?: AssistantErrorCode;
} {
  const safe =
    error instanceof AssistantStreamError
      ? [...error.events]
          .reverse()
          .find(
            (event): event is Extract<AssistantEvent, { type: "error" }> =>
              event.type === "error" && event.safe_to_display === true,
          )
      : undefined;
  if (!safe) return { message: ASSISTANT_ERROR_MESSAGE };
  return {
    message: safe.message,
    safe_to_display: true,
    ...(safe.code ? { code: safe.code } : {}),
  };
}

function sanitizeAssistantEvent(event: AssistantEvent): AssistantEvent {
  if (event.type === "error") {
    return event.safe_to_display
      ? event
      : { ...event, message: ASSISTANT_ERROR_MESSAGE };
  }
  if ("error" in event && typeof event.error === "string" && event.error) {
    if (event.type === "doc_search") {
      return { ...event, ...documentSearchError(event.error_code) };
    }
    if (event.type === "web_search" || event.type === "web_read") {
      return { ...event, error: webToolErrorMessage(event.error_code) };
    }
    if (event.type === "python_run") {
      return { ...event, error: pythonRunErrorMessage(event.error_code, event.error) };
    }
    return { ...event, error: TOOL_ERROR_MESSAGE };
  }
  return event;
}

export function sanitizeAssistantSseChunk(chunk: string): string {
  if (!chunk.startsWith("data: ")) return chunk;
  const payload = chunk.slice(6).trim();
  if (!payload || payload === "[DONE]") return chunk;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return chunk;
    }
    const sanitized = sanitizeAssistantEvent(parsed as AssistantEvent);
    return `data: ${JSON.stringify(sanitized)}\n\n`;
  } catch {
    return chunk;
  }
}

export class AssistantStreamAbortError extends AssistantStreamError {
  constructor(fullText: string, events: AssistantEvent[]) {
    super("Stream aborted.", fullText, events);
    this.name = "AbortError";
  }
}

class AssistantStreamAskInputsPause extends Error {
  constructor() {
    super("Waiting for user input.");
    this.name = "AssistantStreamAskInputsPause";
  }
}

function isAskInputsPause(error: unknown): boolean {
  if (error instanceof AssistantStreamAskInputsPause) return true;
  if (!error || typeof error !== "object") return false;
  const record = error as {
    name?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (
    record.name === "AssistantStreamAskInputsPause" ||
    record.message === "Waiting for user input."
  ) {
    return true;
  }
  return record.cause !== error && isAskInputsPause(record.cause);
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  return record.name === "AbortError" || record.message === "Stream aborted.";
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  throw err;
}

export async function runLLMStream(params: {
  apiMessages: unknown[];
  docStore: DocStore;
  docIndex: DocIndex;
  userId: string;
  /**
   * The caller's authenticated email. Direct (email-keyed) grants are part of
   * the per-document role check edit_document runs before it writes, so a
   * surface that omits it only lets the model edit documents the caller
   * reaches as creator or organization member.
   */
  userEmail?: string | null;
  db: Db;
  write: (s: string) => void;
  onActivity?: () => void;
  extraTools?: unknown[];
  includeResearchTools?: boolean;
  /** How this turn may search the web; null or omitted means it may not. */
  webSearch?: WebSearchPlan | null;
  /** Expose ask_inputs only to clients that can render and answer it. */
  includeAskInputs?: boolean;
  /** Visuals need a panel to show them in; tabular review has none. */
  includeVisuals?: boolean;
  /** Offer run_python: the user's setting, the deployment switch and the sandbox all allow it. */
  codeAnalysis?: boolean;
  /**
   * The surface continues a paused turn from an ask_inputs_response, so a
   * connector write can wait there for the user's approval. Surfaces without
   * that continuation refuse writes that need approval instead.
   */
  connectorApprovals?: boolean;
  /**
   * May this turn WRITE documents (edit_document, replicate_document, the
   * generate_* family)? Defaults to true; pass false and those tools are
   * neither advertised to the model nor executed if it asks for one anyway.
   *
   * The caller decides this from the role the caller holds on the CONTAINER
   * whose documents the tools would touch — not from their standing in the
   * chat. The two come apart: a project viewer named on one chat's share
   * list writes in that thread as a member, and without this partition the
   * thread would hand them edit_document over every document in the project.
   */
  allowDocumentMutation?: boolean;
  workflowStore?: WorkflowStore;
  tabularStore?: TabularCellStore;
  /** Tools executed by the connected client (Word add-in) instead of here. */
  clientTools?: ClientToolsAdapter;
  /**
   * Tool-loop iteration budget (default 10). Surfaces whose tools are built
   * around retry round-trips (Word client edits: propose → fail → re-read →
   * retry) need headroom, or the loop ends before the model's summary.
   */
  maxIterations?: number;
  buildCitations?: (fullText: string) => unknown[];
  model?: string;
  /** AI SDK reasoning effort for this interactive request. */
  reasoning?: import("../../../lib/llm").ReasoningLevel;
  apiKeys?: import("../../../lib/llm").UserApiKeys;
  /**
   * The organization the conversation belongs to. `apiKeys` are already the
   * ones it runs on; this is for the model-list check below, which must use
   * the same organization's lists.
   */
  orgId?: string | null;
  signal?: AbortSignal;
  /** Let a route persist the completed turn before it signals stream success. */
  emitDone?: boolean;
  /** Add read-only app/project memory as an earliest untrusted reference turn. */
  includeMemory?: boolean;
  /** Memory scope is independent from generated-document destination. */
  memoryProjectId?: string | null;
  /** Tell the memory policy whether other people can see the persisted turn. */
  memorySharedAudience?: boolean;
  /**
   * If set, generate_docx will attach created docs to this project so
   * they appear in the project sidebar. Leave null for general chats —
   * generated docs still get persisted, but as standalone documents.
   */
  projectId?: string | null;
  /** Spotlighting nonce — generated by the caller and passed here so that
   *  the same nonce fences both the system-prompt filenames (added by
   *  buildMessages) and the document bodies returned by tools. */
  nonce?: string;
  /** Durable conversation id, forwarded to the provider as a cache hint. */
  conversationId?: string | null;
  subagentRuns?: SubagentRunStore | null;
  subagentDefaults?: SubagentDefaults;
  /** Shares its answer's connector tools, web pages, case cache and document edits. */
  subagentRun?: {
    connectorTools: unknown[];
    /** Only these of the answer's tools, client tools included; omitted means all but the excluded ones. */
    tools?: ReadonlySet<string>;
    webTurnState: WebTurnState;
    pythonTurnState: PythonTurnState;
    courtlistenerTurnState: CourtlistenerTurnState;
    turnEditState: TurnEditState;
    documentLocks: KeyedLock;
    documentsScoped: boolean;
    onToolStart: (name: string) => void;
    onUsage: (usage: TokenUsage, finishReason: string) => void;
    onToolBatch: (
      calls: NormalizedToolCall[],
      results: NormalizedToolResult[],
    ) => void;
  };
}): Promise<{
  fullText: string;
  events: AssistantEvent[];
  citations: unknown[];
}> {
  const {
    apiMessages,
    docStore,
    docIndex,
    userId,
    userEmail,
    db,
    write: unsafeWrite,
    extraTools,
    includeResearchTools = true,
    webSearch = null,
    includeAskInputs = true,
    includeVisuals = true,
    codeAnalysis = false,
    connectorApprovals = false,
    allowDocumentMutation = true,
    workflowStore,
    tabularStore,
    clientTools,
    buildCitations,
    model,
    apiKeys,
    orgId,
    signal,
    projectId,
    includeMemory = false,
    memoryProjectId,
    memorySharedAudience = false,
    nonce,
    conversationId,
    subagentRuns = null,
    subagentDefaults,
    subagentRun,
  } = params;
  const write = (chunk: string) =>
    unsafeWrite(sanitizeAssistantSseChunk(chunk));
  const isSubagent = subagentRun !== undefined;
  const researchTools = includeResearchTools ? COURTLISTENER_TOOLS : [];
  // The person's own connections for the workspace this conversation is in.
  const connectorTools =
    subagentRun?.connectorTools ??
    (await (async () => {
      const owner = { userId, orgId: await teamOrgIdOf(db, orgId) };
      return [
        ...(await buildUserMcpTools(owner, db)),
        ...(await buildGoogleDriveTools(owner, db)),
        ...(await buildGoogleWorkspaceTools(owner, db)),
      ];
    })());
  // A subagent's approvals pause its answer, which puts them to the user.
  const canPauseForApproval =
    connectorApprovals && (includeAskInputs || isSubagent);
  const conversationTools = includeAskInputs
    ? TOOLS
    : TOOLS.filter((tool) => tool.function.name !== "ask_inputs");
  const webTools = webToolsFor(webSearch);
  const webSearchAccount = webSearchAccountFor(webSearch, apiKeys);
  const webToolNames = new Set<string>(
    webTools.map((tool) => tool.function.name),
  );
  // An invalid model fails the answer below, before any tool runs.
  const chatModel = resolveModel(model, "");
  const baseTools = [
    ...conversationTools,
    ...researchTools,
    ...WORKFLOW_TOOLS,
    ...PLAYBOOK_TOOLS,
    ...webTools,
    ...(includeVisuals ? visualTools({ codeAnalysis }) : []),
    ...pythonToolsFor(codeAnalysis),
    ...(subagentRuns && chatModel
      ? [delegateTool(chatModel, sameProviderModels(chatModel, apiKeys ?? {}))]
      : []),
  ];
  const advertisedTools = [
    ...baseTools,
    ...connectorTools,
    ...(extraTools ?? []),
    ...(clientTools?.schemas ?? []),
  ];
  // Hiding the schema is the first half of the gate: a tool the model was
  // never shown is a tool it will not plan around. The second half is in
  // `runTools` below, because "not advertised" is not "not callable" — a
  // model can name a tool from memory.
  const permittedTools = allowDocumentMutation
    ? advertisedTools
    : withoutDocumentMutatingTools(advertisedTools);
  const subagentMayCall = (name: string) =>
    !subagentRun ||
    (!SUBAGENT_EXCLUDED_TOOL_NAMES.has(name) &&
      (!subagentRun.tools || subagentRun.tools.has(name)));
  const activeTools = permittedTools.filter((tool) =>
    subagentMayCall(toolName(tool) ?? ""),
  );

  // Extract system prompt; pass remaining turns to the adapter as
  // plain user/assistant messages (assistant turns may carry stored
  // reasoning, which only reasoning-replaying models receive).
  const rawMsgs = apiMessages as {
    role: string;
    content: string | null;
    reasoning?: string;
  }[];
  const baseSystemPrompt =
    rawMsgs[0]?.role === "system" ? (rawMsgs[0].content ?? "") : "";
  const memory = await buildMemoryTurn({
    db,
    userId,
    systemPrompt: baseSystemPrompt,
    include: includeMemory,
    projectId: memoryProjectId,
    orgId,
    sharedAudience: memorySharedAudience,
  });
  const offersVisuals = activeTools.some((tool) => toolName(tool) === VISUAL_TOOL_NAMES.generate);
  const offersPython = activeTools.some((tool) => toolName(tool) === PYTHON_TOOL_NAME);
  const systemPrompt = [
    memory.systemPrompt,
    ...(webSearch
      ? [
          WEB_SEARCH_SYSTEM_PROMPT,
          webSearch === "provider"
            ? PROVIDER_WEB_READ_SYSTEM_PROMPT
            : MIKE_WEB_SEARCH_SYSTEM_PROMPT,
        ]
      : []),
    ...(subagentRuns ? [delegateSystemPrompt(subagentDefaults)] : []),
    // Computed from the tools actually offered, so read-only callers and
    // subagents are never told about a tool they cannot call.
    ...(offersVisuals ? [visualsSystemPrompt(offersPython)] : []),
    ...(offersPython ? [CODE_ANALYSIS_SYSTEM_PROMPT] : []),
  ].join("\n\n");
  const chatMessages: LlmMessage[] = rawMsgs
    .filter((m) => m.role !== "system")
    .map(
      (m): LlmMessage =>
        m.role === "assistant" && m.reasoning
          ? { role: "assistant", content: m.content ?? "", reasoning: m.reasoning }
          : {
              role: m.role === "assistant" ? "assistant" : "user",
              content: m.content ?? "",
            },
    )
    // An assistant turn with no text (an error, a cancellation, or a client
    // that keeps prose in events) carries nothing for the model, and Anthropic
    // rejects the entire request over one empty text block.
    .filter((m) => m.role === "user" || m.content.trim().length > 0);
  // Before every real turn: see MemoryTurn for why it goes there.
  if (memory.message) chatMessages.unshift(memory.message);

  const events: AssistantEvent[] = [];
  // One assistant turn produces at most one document_versions row per
  // edited doc. `runToolCalls` fires once per tool-call batch; the model
  // may emit multiple batches in a single turn, so this map persists
  // across batches to let subsequent edit_document calls overwrite the
  // turn's existing version instead of creating a new one.
  const turnEditState: TurnEditState = subagentRun?.turnEditState ?? new Map();
  const documentLocks = subagentRun?.documentLocks ?? createKeyedLock();
  const visualTurnState = createVisualTurnState();
  const pythonTurnState = subagentRun?.pythonTurnState ?? createPythonTurnState();
  // Suppress repeated full-document reads for the same document/version in
  // one assistant response. The guard is invalidated when edit_document
  // changes that document so a post-edit verification read can still happen.
  const turnReadState: TurnReadState = new Map();
  const courtlistenerTurnState: CourtlistenerTurnState =
    subagentRun?.courtlistenerTurnState ?? { casesByClusterId: new Map() };
  const webTurnState =
    subagentRun?.webTurnState ??
    createWebTurnState(
      webSearch
        ? ([...rawMsgs].reverse().find((m) => m.role === "user")?.content ?? "")
        : "",
    );
  const providerWebSearch = createProviderWebSearchTracker(webTurnState);
  // What the answer ran on, reported in its closing response_details event.
  // The tokens are this assistant's own, summed over its steps; each
  // subagent reports its own on its delegation event.
  let answerModel: string | null = null;
  let answerUsage: { input_tokens: number; output_tokens: number } | null = null;
  let fullText = "";
  let iterText = "";
  let iterVisibleText = "";
  let iterReasoning = "";
  let visibleTailBuffer = "";
  let citationsOpenSeen = false;
  let streamingCitationsBuffer = "";
  let streamedCitationCount = 0;

  const emitCitationStreamSnapshot = (
    status: "started" | "partial",
    citations: unknown[],
  ) => {
    if (buildCitations) return;
    write(
      `data: ${JSON.stringify({ type: "citations", status, citations })}\n\n`,
    );
  };

  const streamHiddenCitationContent = (delta: string) => {
    if (buildCitations || !delta) return;
    streamingCitationsBuffer += delta;
    const partial = parsePartialCitationObjects(streamingCitationsBuffer);
    if (partial.length <= streamedCitationCount) return;
    streamedCitationCount = partial.length;
    const citations = partial.map((c) =>
      createCitation(
        c,
        docIndex,
        courtlistenerTurnState.casesByClusterId,
        docStore,
      ),
    );
    emitCitationStreamSnapshot("partial", citations);
  };

  const streamVisibleContent = (delta: string) => {
    if (!delta) return;
    if (citationsOpenSeen) {
      streamHiddenCitationContent(delta);
      return;
    }

    const combined = visibleTailBuffer + delta;
    const markerIdx = combined.indexOf(CITATIONS_OPEN_TAG);
    if (markerIdx >= 0) {
      const visible = combined.slice(0, markerIdx);
      if (visible) {
        iterVisibleText += visible;
        write(
          `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
        );
      }
      visibleTailBuffer = "";
      citationsOpenSeen = true;
      streamingCitationsBuffer = "";
      streamedCitationCount = 0;
      emitCitationStreamSnapshot("started", []);
      streamHiddenCitationContent(
        combined.slice(markerIdx + CITATIONS_OPEN_TAG.length),
      );
      return;
    }

    const keep = Math.min(CITATIONS_OPEN_TAG.length - 1, combined.length);
    const visible = combined.slice(0, combined.length - keep);
    visibleTailBuffer = combined.slice(combined.length - keep);
    if (visible) {
      iterVisibleText += visible;
      write(
        `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
      );
    }
  };

  const flushVisibleTail = (opts: { emit?: boolean } = {}) => {
    const emit = opts.emit ?? true;
    if (citationsOpenSeen || !visibleTailBuffer) {
      visibleTailBuffer = "";
      return;
    }
    iterVisibleText += visibleTailBuffer;
    if (emit) {
      write(
        `data: ${JSON.stringify({ type: "content_delta", text: visibleTailBuffer })}\n\n`,
      );
    }
    visibleTailBuffer = "";
  };

  const flushText = (opts: { emit?: boolean } = {}) => {
    if (!iterText) return;
    fullText += iterText;
    flushVisibleTail(opts);
    if (iterVisibleText) {
      events.push({ type: "content", text: iterVisibleText });
    }
    iterText = "";
    iterVisibleText = "";
    visibleTailBuffer = "";
    citationsOpenSeen = false;
    streamingCitationsBuffer = "";
    streamedCitationCount = 0;
  };

  const flushPartialTurn = (opts: { emit?: boolean } = {}) => {
    flushText(opts);
    if (iterReasoning) {
      events.push({ type: "reasoning", text: iterReasoning });
      iterReasoning = "";
    }
  };

  // A failed answer stops its subagents too, not only a stopped one.
  const delegationStop = new AbortController();
  const delegationSignal = signal
    ? AbortSignal.any([signal, delegationStop.signal])
    : delegationStop.signal;
  const delegateContextFor = (
    runStore: SubagentRunStore,
    selectedModel: string,
  ): DelegateContext => ({
    state: createDelegateTurnState(),
    chatModel: selectedModel,
    reasoning: params.reasoning ?? "high",
    systemPrompt: baseSystemPrompt,
    webTurnState,
    docStore,
    docIndex,
    runStore,
    checkModel: async (requested) => {
      const checked = await resolveEffectiveChatModel({
        requested,
        apiKeys: apiKeys ?? {},
        userId,
        db,
        orgId,
      }).catch((error) => {
        console.error("[subagents] model check failed", safeError(error));
        return null;
      });
      return checked?.ok ? checked.model : null;
    },
    nonce,
    signal: delegationSignal,
    write,
    spawn: (spawn) =>
      runLLMStream({
        // A subagent's question ends its run the way ask_inputs ends a turn.
        clientTools: {
          schemas: [ASK_PARENT_TOOL],
          owns: (name) => name === ASK_PARENT_TOOL_NAME,
          execute: async (call) => {
            spawn.askParent(call.input.question);
            throw new AssistantStreamAskInputsPause();
          },
        },
        apiMessages: spawn.apiMessages,
        docStore: spawn.docStore,
        docIndex: spawn.docIndex,
        userId,
        userEmail,
        db,
        extraTools,
        workflowStore,
        tabularStore,
        projectId,
        orgId,
        apiKeys,
        nonce,
        webSearch,
        includeResearchTools,
        codeAnalysis,
        onActivity: params.onActivity,
        write: () => {},
        model: spawn.model,
        reasoning: spawn.reasoning,
        maxIterations: spawn.maxSteps,
        signal: spawn.signal,
        subagentRun: {
          connectorTools,
          webTurnState: spawn.webTurnState,
          pythonTurnState: createChildPythonTurnState(pythonTurnState),
          courtlistenerTurnState,
          turnEditState,
          documentLocks,
          documentsScoped: spawn.documentsScoped,
          onToolStart: spawn.onToolStart,
          onUsage: spawn.onUsage,
          onToolBatch: spawn.onToolBatch,
        },
        includeAskInputs: false,
        connectorApprovals: canPauseForApproval,
        allowDocumentMutation,
        emitDone: false,
      }),
  });
  // The visual builder is a subagent with the document reading tools and
  // save_visual, which runs the answer's own lint-and-save pipeline. Its
  // events are recorded after the step; a step the answer stopped or failed
  // in never gets there, so recordDelegations records them.
  const unrecordedBuilds: DelegationEvent[] = [];
  const visualBuilderFor =
    (selectedModel: string): VisualBuilder =>
    (run) =>
      runVisualBuild(run, {
        model: selectedModel,
        reasoning: params.reasoning ?? "high",
        signal: delegationSignal,
        write,
        spawn: (spawn) =>
          runLLMStream({
            clientTools: {
              schemas: [spawn.saveTool.schema],
              owns: (name) => name === spawn.saveTool.schema.function.name,
              execute: async (call) => ({
                content: await spawn.saveTool.execute(call),
                events: [],
              }),
            },
            apiMessages: spawn.apiMessages,
            docStore: spawn.docStore,
            docIndex: spawn.docIndex,
            userId,
            userEmail,
            db,
            extraTools,
            projectId,
            orgId,
            apiKeys,
            nonce,
            includeResearchTools: false,
            includeAskInputs: false,
            includeVisuals: false,
            allowDocumentMutation: false,
            onActivity: params.onActivity,
            write: () => {},
            model: selectedModel,
            reasoning: params.reasoning ?? "high",
            maxIterations: spawn.maxSteps,
            signal: spawn.signal,
            subagentRun: {
              connectorTools: [],
              tools: VISUAL_BUILDER_TOOL_NAMES,
              webTurnState,
              pythonTurnState,
              courtlistenerTurnState,
              turnEditState,
              documentLocks,
              documentsScoped: spawn.documentsScoped,
              onToolStart: spawn.onToolStart,
              onUsage: spawn.onUsage,
              onToolBatch: () => {},
            },
            emitDone: false,
          }),
      }).then((result) => {
        unrecordedBuilds.push(result.event);
        return result;
      });
  // A subagent starts as soon as the model has written its delegate call, not
  // when the model's whole step ends, and reports back when it finishes.
  const delegationRuns = new Map<string, Promise<DelegateResult>>();
  const startDelegation = (call: NormalizedToolCall, context: DelegateContext) => {
    let run = delegationRuns.get(call.id);
    if (!run) {
      run = runDelegateCall(call, context).then((result) => {
        if (result.event) write(`data: ${JSON.stringify(result.event)}\n\n`);
        return result;
      });
      delegationRuns.set(call.id, run);
    }
    return run;
  };
  // Records every delegation started so far, including those no tool batch
  // collected: a stopped or failed answer ends the model's stream without
  // waiting for its tools, and a retried or final step never runs them.
  const recordDelegations = async () => {
    const runs = [...delegationRuns.values()];
    delegationRuns.clear();
    for (const { event } of await Promise.all(runs)) if (event) events.push(event);
    for (const event of unrecordedBuilds.splice(0)) events.push(event);
  };

  try {
    throwIfAborted(signal);
    // Single request-time choke point for every runLLMStream caller (chat,
    // project chat, Word chat, tabular): router-prefixed models must be in the
    // user's saved selection.
    //
    // This lives INSIDE the try because it touches the database. Above it, a
    // read failure escaped as a bare rejection — before any error event was
    // pushed and before AssistantStreamError could carry the partial turn — so
    // the SSE client saw the socket end with no explanation. Inside, a blip
    // takes the same path as any other mid-stream failure.
    //
    // "throw" (not silent fallback) because `model` here is what the caller
    // asked for in THIS request. Stored task models are validated by their
    // route before they arrive here, but this guard keeps every caller safe.
    const requestedModel = resolveModel(model, "");
    if (!requestedModel) {
      throw new UserFacingError(
        model
          ? `Model "${model}" is not available. Select another model.`
          : "Select a model before sending a message.",
      );
    }
    const selectedModel = await resolveRequestedModel(
      requestedModel,
      "",
      userId,
      db,
      "throw",
      orgId,
    );
    answerModel = selectedModel;
    const delegateContext = subagentRuns && delegateContextFor(subagentRuns, selectedModel);
    const visualBuilder = isSubagent ? undefined : visualBuilderFor(selectedModel);
    const providerSearches =
      webSearch === "provider" ? providerWebSearch.reserve() : 0;
    await streamChatWithTools({
      model: selectedModel,
      systemPrompt,
      messages: chatMessages,
      tools: activeTools as OpenAIToolSchema[],
      // Keep in step with DEFAULT_MAX_ITERATIONS in llm/aiSdk.ts. Deliberately
      // a literal, not an import: tests mock the "../llm" barrel, and reaching
      // past it into llm/aiSdk loads the real SDK module into suites that only
      // ever wanted the mock, which broke unrelated tests at random.
      maxIterations: params.maxIterations ?? 16,
      apiKeys,
      reasoning: params.reasoning ?? "high",
      abortSignal: signal,
      conversationId,
      providerWebSearch:
        providerSearches > 0 ? { maxSearches: providerSearches } : null,
      finishWithoutToolsOnLastStep: isSubagent,
      callbacks: {
        onActivity: params.onActivity,
        onUsage: (usage, finishReason) => {
          answerUsage = {
            input_tokens: (answerUsage?.input_tokens ?? 0) + usage.inputTokens,
            output_tokens: (answerUsage?.output_tokens ?? 0) + usage.outputTokens,
          };
          subagentRun?.onUsage(usage, finishReason);
        },
        onContentDelta: (delta) => {
          iterText += delta;
          streamVisibleContent(delta);
        },
        onReasoningDelta: (delta) => {
          iterReasoning += delta;
          write(
            `data: ${JSON.stringify({ type: "reasoning_delta", text: delta })}\n\n`,
          );
        },
        onReasoningBlockEnd: () => {
          if (!iterReasoning) return;
          events.push({ type: "reasoning", text: iterReasoning });
          write(`data: ${JSON.stringify({ type: "reasoning_block_end" })}\n\n`);
          iterReasoning = "";
        },
        // Fires as soon as the model has written a tool call, while the step's
        // tools run only once the whole step ends. Flushes any buffered text
        // so it's emitted in order, then lets the client show "Working…"
        // until the tool's first event arrives.
        onToolCallStart: (call) => {
          flushText();
          subagentRun?.onToolStart(call.name);
          write(
            `data: ${JSON.stringify({
              type: "tool_call_start",
              name: call.name,
            })}\n\n`,
          );
          if (
            delegateContext &&
            call.name === DELEGATE_TOOL_NAME &&
            !call.invalid
          ) {
            void startDelegation(call, delegateContext);
          }
        },
        onWebSearch: (progress) => {
          const { frame, event } = providerWebSearch.handle(progress);
          if (frame) {
            flushText();
            subagentRun?.onToolStart(WEB_TOOL_NAMES.search);
            write(`data: ${JSON.stringify(frame)}\n\n`);
          }
          if (event) {
            events.push(event);
            write(`data: ${JSON.stringify(event)}\n\n`);
          }
        },
      },
      runTools: async (calls) => {
        throwIfAborted(signal);
        // Emit any text the model produced before this tool turn so the
        // UI sees it before the tool results stream in.
        flushText();

        // Web tools and client-executed tools (Word add-in) never enter the
        // server dispatcher. Web calls run in parallel. Client calls
        // round-trip through the SSE stream sequentially: each one mutates or
        // reads the live document, so order is part of their semantics.
        const clientResultByCallId = new Map<string, string>();
        // Enforcement, not just omission: a document-writing call from a
        // caller who may not write is dropped before dispatch, on the server
        // side and the client side alike. It falls through to the
        // "Tool 'x' is not available." answer below, which every tool_use
        // without a result already gets, so the model is told plainly rather
        // than left waiting on a call that silently did nothing.
        const permittedCalls = calls.filter(
          (c) =>
            (allowDocumentMutation || !isDocumentMutatingTool(c.name)) &&
            subagentMayCall(c.name),
        );
        const webCalls = permittedCalls.filter((c) => webToolNames.has(c.name));
        const delegateCalls = permittedCalls.filter(
          (c) => c.name === DELEGATE_TOOL_NAME,
        );
        const handledElsewhere = (c: NormalizedToolCall) =>
          webToolNames.has(c.name) ||
          c.name === DELEGATE_TOOL_NAME ||
          !!clientTools?.owns(c.name);
        const serverCalls = permittedCalls.filter((c) => !handledElsewhere(c));
        const delegating = Promise.all(
          delegateContext
            ? delegateCalls.map((call) => startDelegation(call, delegateContext))
            : [],
        );
        const webResults = await Promise.all(
          webCalls.map((call) =>
            runWebToolCall(call, {
              state: webTurnState,
              account: webSearchAccount,
              nonce,
              signal,
              write,
            }),
          ),
        );
        throwIfAborted(signal);
        webCalls.forEach((call, index) => {
          const { content, event } = webResults[index];
          clientResultByCallId.set(call.id, content);
          events.push(event);
          write(`data: ${JSON.stringify(event)}\n\n`);
        });
        if (clientTools) {
          for (const call of permittedCalls) {
            if (!clientTools.owns(call.name)) continue;
            const { content, events: clientEvents } =
              await clientTools.execute(call);
            clientResultByCallId.set(call.id, content);
            events.push(...clientEvents);
            throwIfAborted(signal);
          }
        }

        const toolCalls: ToolCall[] = serverCalls.map((c) => ({
          id: c.id,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input),
          },
        }));
        const {
          toolResults,
          docsRead,
          docsFound,
          documentSearchEvents,
          docsCreated,
          docsReplicated,
          workflowsApplied,
          docsEdited,
          askInputsEvents,
          textCardEvents,
          courtlistenerEvents,
          caseCitationEvents,
          mcpEvents,
          pythonEvents,
        } = await runToolCalls(
          toolCalls,
          docStore,
          userId,
          db,
          write,
          workflowStore,
          tabularStore,
          docIndex,
          turnEditState,
          turnReadState,
          projectId,
          courtlistenerTurnState,
          apiKeys,
          nonce,
          {
            connectorApprovals: canPauseForApproval,
            userEmail,
            orgId,
            model: selectedModel,
            documentLocks,
            documentsScoped: subagentRun?.documentsScoped,
            visualTurnState,
            visualData: pythonTurnState.results,
            visualBuilder,
            pythonTurnState: codeAnalysis ? pythonTurnState : undefined,
            pythonAllowSave: allowDocumentMutation,
            signal,
          },
        );
        throwIfAborted(signal);
        for (const r of docsRead) {
          events.push({
            type: "doc_read",
            filename: r.filename,
            document_id: r.document_id,
            version_id: r.version_id,
            version_number: r.version_number,
          });
        }
        for (const f of docsFound) {
          events.push({
            type: "doc_find",
            filename: f.filename,
            document_id: f.document_id,
            version_id: f.version_id,
            version_number: f.version_number,
            query: f.query,
            total_matches: f.total_matches,
          });
        }
        events.push(...(documentSearchEvents ?? []));
        events.push(...(textCardEvents ?? []));
        events.push(...unrecordedBuilds.splice(0));
        for (const dl of docsCreated) {
          events.push({
            type: "doc_created",
            filename: dl.filename,
            download_url: dl.download_url,
            document_id: dl.document_id,
            version_id: dl.version_id,
            version_number: dl.version_number ?? null,
          });
        }
        for (const r of docsReplicated) {
          events.push({
            type: "doc_replicated",
            filename: r.filename,
            count: r.count,
            copies: r.copies,
          });
        }
        for (const wf of workflowsApplied) {
          events.push({
            type: "workflow_applied",
            workflow_id: wf.workflow_id,
            title: wf.title,
          });
        }
        for (const e of docsEdited) {
          events.push({
            type: "doc_edited",
            filename: e.filename,
            document_id: e.document_id,
            version_id: e.version_id,
            version_number: e.version_number,
            download_url: e.download_url,
            annotations: e.annotations,
          });
        }
        for (const event of courtlistenerEvents) {
          events.push(event);
        }
        for (const event of mcpEvents) {
          events.push(event);
        }
        for (const event of caseCitationEvents) {
          events.push(event);
        }
        events.push(...(pythonEvents ?? []));

        const delegated = await delegating;
        // Once the answer has stopped or failed, its catch records these.
        throwIfAborted(delegationSignal);
        delegated.forEach(({ content }, index) =>
          clientResultByCallId.set(delegateCalls[index].id, content),
        );
        await recordDelegations();
        addApprovalItems(
          askInputsEvents,
          delegated.flatMap(({ approvals }) => approvals ?? []),
        );
        for (const askInputsEvent of askInputsEvents) {
          write(`data: ${JSON.stringify(askInputsEvent)}\n\n`);
          events.push(askInputsEvent);
        }
        // Index alignment would break if any tool branch skips its
        // push (unhandled tool name, disabled store, guard failure).
        // Each tool_result already carries its tool_call_id, so key off
        // that directly — and fall back to an error result for any
        // tool_use that didn't produce one, so Claude's next request
        // has a tool_result for every tool_use it sent.
        const resultByCallId = new Map<string, string>(clientResultByCallId);
        for (const r of toolResults) {
          const row = r as {
            tool_call_id: string;
            content?: unknown;
          };
          resultByCallId.set(row.tool_call_id, String(row.content ?? ""));
        }
        // Answer every tool_use the model sent — client and server alike —
        // in the model's original call order.
        const results = calls.map((c) => ({
          tool_use_id: c.id,
          content:
            resultByCallId.get(c.id) ??
            JSON.stringify({
              error: `Tool '${c.name}' is not available.`,
            }),
        }));
        // Recorded before a pause too, so a continued subagent knows what
        // already ran beside the actions awaiting approval.
        subagentRun?.onToolBatch(calls, results);
        if (askInputsEvents.length > 0) {
          throw new AssistantStreamAskInputsPause();
        }
        return results;
      },
    }).finally(() => providerWebSearch.release());
    await recordDelegations();
  } catch (err) {
    if (isAskInputsPause(err)) {
      // The ask_inputs event has already been emitted and persisted in `events`.
      // Stop this assistant turn here so the model does not add redundant
      // prose telling the user to answer the picker or attach documents.
    } else if (isAbortError(err)) {
      await recordDelegations().catch(() => {});
      flushPartialTurn({ emit: false });
      throw new AssistantStreamAbortError(
        fullText,
        events.map(sanitizeAssistantEvent),
      );
    } else {
      delegationStop.abort();
      await recordDelegations().catch(() => {});
      flushPartialTurn();
      const safeToDisplay = err instanceof UserFacingError;
      // The response already started, so the HTTP 500 path never sees this:
      // it is the one report of the turn's failure. Reporting it HERE, before
      // any console.error, is what lets the console bridge recognise every
      // later log of it — this line's, and the route's log of the
      // AssistantStreamError below, whose `cause` is `err` — as already sent.
      // A UserFacingError (rejected or missing API key, model not allowed)
      // is the user's configuration rather than our bug: still one event, so
      // operators see a rejected key with its provider_error tag, but a
      // warning, not an error. (Left unreported, the console bridge filed it
      // anyway, at error level, as MIKE-BACKEND-E.)
      reportError(err, {
        tags: { component: "chat-stream" },
        ...(safeToDisplay ? { level: "warning" as const } : {}),
      });
      console.error("[chat/stream] model stream failed", err);
      const message = safeToDisplay ? err.message : ASSISTANT_ERROR_MESSAGE;
      events.push({
        type: "error",
        message,
        ...(safeToDisplay ? { safe_to_display: true } : {}),
        // A rejected key is worth naming: the client turns this into a prompt
        // to go fix the key rather than a suggestion to retry.
        ...(err instanceof InvalidApiKeyError
          ? { code: "invalid_api_key" as const }
          : {}),
      });
      throw new AssistantStreamError(
        message,
        fullText,
        events.map(sanitizeAssistantEvent),
        { cause: err },
      );
    }
  }

  flushText();

  const citedWebSources = providerWebSearch.citedSources();
  if (citedWebSources) {
    events.push(citedWebSources);
    write(`data: ${JSON.stringify(citedWebSources)}\n\n`);
  }

  // Parse and emit citations from <CITATIONS> block
  const { citations: parsedCitations, diagnostics: citationDiagnostics } =
    parseCitationsWithDiagnostics(fullText);
  let citations: unknown[];
  if (buildCitations) {
    // Custom builders (tabular) bypass document-citation verification.
    citations = buildCitations(fullText);
  } else {
    const rawCitations = parsedCitations.map((c) =>
      createCitation(
        c,
        docIndex,
        courtlistenerTurnState.casesByClusterId,
        docStore,
      ),
    );
    // Server-side quote verification. Fetch each document's extracted source
    // text at most once per turn (memoized by doc_id), reading only bytes
    // already in storage with emitEvents:false. Case citations are matched
    // against the opinion text cached during this turn.
    const sourceTextByDocId = new Map<string, Promise<string>>();
    const getSourceText = (docId: string): Promise<string> => {
      let pending = sourceTextByDocId.get(docId);
      if (!pending) {
        const label = resolveDocLabel(docId, docStore, docIndex);
        pending = label
          ? readDocumentContent(label, docStore, () => {}, docIndex, db, {
              emitEvents: false,
            })
          : Promise.resolve("");
        sourceTextByDocId.set(docId, pending);
      }
      return pending;
    };
    citations = await verifyCitations(
      rawCitations,
      getSourceText,
      async (clusterId) =>
        getCachedCaseOpinionTexts(courtlistenerTurnState, clusterId),
    );
  }
  devLog("[chat/stream] final citations", {
    hasCitationsBlock: citationDiagnostics.hasBlock,
    citationsBlockLength: citationDiagnostics.rawLength,
    parseError: citationDiagnostics.error,
    parsedCitationCount: parsedCitations.length,
    emittedCitationCount: citations.length,
    usedCustomCitationBuilder: !!buildCitations,
  });
  write(
    `data: ${JSON.stringify({ type: "citations", status: "final", citations })}\n\n`,
  );
  if (!isSubagent && answerModel) {
    const details: AssistantEvent = {
      type: "response_details",
      model: answerModel,
      reasoning: params.reasoning ?? "high",
      ...(answerUsage ? { usage: answerUsage } : {}),
    };
    events.push(details);
    write(`data: ${JSON.stringify(details)}\n\n`);
  }
  if (params.emitDone !== false) {
    write("data: [DONE]\n\n");
  }

  return {
    fullText,
    events: events.map(sanitizeAssistantEvent),
    citations,
  };
}
