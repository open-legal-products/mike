import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { enqueueChatTurnAudit } from "../lib/audit";
import {
    buildDocContext,
    buildMessages,
    buildUserPersonalisationPrompt,
    enrichWithPriorEvents,
    buildWorkflowStore,
    appendAskInputsResponseToLastAssistantMessage,
    appendAssistantEventsToLastAssistantMessage,
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    extractCitations,
    generateSpotlightNonce,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    parseChatMessages,
    parseOptionalAskInputsResponse,
    parseOptionalChatId,
    parseOptionalModel,
    parseOptionalReasoning,
    parseOptionalProjectId,
    createReservedAssistantMessageUpdater,
    openAssistantSse,
    reserveAssistantMessage,
    withoutEmptyAssistantReservations,
    MAX_ACTIVE_CHAT_AGENTS,
    buildChatAgentSystemPrompt,
    countPendingEditProposals,
    createEditProposalToolsAdapter,
    deriveChatAgentStatus,
    parseAssistantMessageContent,
    parseOptionalAgentAssignment,
    setEditProposalStatus,
} from "../lib/chat";
import {
    getUserModelSettings,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
} from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { generateAssistantChatTitle } from "../lib/chatTitle";
import { sendInternalError } from "../lib/httpError";
import {
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../lib/modelSelection";

export const chatRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

type AccessibleChat = {
    id: string;
    title: string | null;
    user_id: string;
    project_id: string | null;
    model: string | null;
    reasoning_level: string | null;
    parent_chat_id?: string | null;
    agent_instruction?: string | null;
    source_message_id?: string | null;
    source_excerpt?: string | null;
} & Record<string, unknown>;

async function validateAccessibleProjectId(
    projectId: string | null,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
    if (!projectId) return { ok: true };
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok)
        return { ok: false, status: 404, detail: "Project not found" };
    return { ok: true };
}

async function getAccessibleChat(
    chatId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<AccessibleChat | null> {
    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .maybeSingle();
    if (error || !chat) return null;

    const row = chat as AccessibleChat;
    if (row.user_id === userId) return row;

    if (row.project_id) {
        const access = await checkProjectAccess(
            row.project_id,
            userId,
            userEmail,
            db,
        );
        if (access.ok) return row;
    }

    return null;
}

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const requestedOffset = Number.parseInt(String(req.query.offset ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 100)
        : null;
    const offset =
        Number.isFinite(requestedOffset) && requestedOffset > 0
            ? requestedOffset
            : 0;

    const { data, error } = await db.rpc("get_chats_overview", {
        p_user_id: userId,
        p_limit: limit,
        p_offset: offset,
    });
    if (error) return void sendInternalError(res, error);
    res.json(data ?? []);
});

// POST /chat/create
//
// Also creates an assigned agent when `parent_chat_id` is present: a chat
// parented to the conversation whose response the user highlighted. Three
// rules keep that safe, all enforced here rather than in the schema because
// they are product rules, not data integrity ones — the parent must be a chat
// the user can already reach, it must not itself be an agent (one level only),
// and one response may carry at most MAX_ACTIVE_CHAT_AGENTS of them.
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const parsedProjectId = parseOptionalProjectId(req.body?.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const parsedAgent = parseOptionalAgentAssignment(req.body);
    if (!parsedAgent.ok) {
        return void res.status(400).json({ detail: parsedAgent.detail });
    }
    const agent = parsedAgent.value;
    const db = createServerSupabase();

    if (agent) {
        const parent = await getAccessibleChat(
            agent.parentChatId,
            userId,
            userEmail,
            db,
        );
        if (!parent) {
            return void res
                .status(404)
                .json({ detail: "Parent chat not found" });
        }
        if (parent.parent_chat_id) {
            return void res
                .status(400)
                .json({ detail: "An agent cannot be assigned its own agents" });
        }
        // A project chat's agents inherit the binding rather than take one, so
        // an explicit mismatch is a client bug worth surfacing.
        const parentProjectId = parent.project_id ?? null;
        if (
            parsedProjectId.value.provided &&
            parsedProjectId.value.projectId !== parentProjectId
        ) {
            return void res
                .status(400)
                .json({ detail: "project_id does not match parent chat" });
        }

        const { count, error: countError } = await db
            .from("chats")
            .select("id", { count: "exact", head: true })
            .eq("parent_chat_id", agent.parentChatId);
        if (countError) return void sendInternalError(res, countError);
        if ((count ?? 0) >= MAX_ACTIVE_CHAT_AGENTS) {
            return void res.status(400).json({
                detail: `This response already has ${MAX_ACTIVE_CHAT_AGENTS} agents. Dismiss one before assigning another.`,
            });
        }

        const { data: created, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: parentProjectId,
                parent_chat_id: agent.parentChatId,
                agent_instruction: agent.agentInstruction,
                source_message_id: agent.sourceMessageId,
                source_excerpt: agent.sourceExcerpt,
                // Agents are labelled by their instruction in the dock, so a
                // generated title would be noise — and title generation is
                // what puts a chat in the history list's mental model.
                title: agent.agentInstruction.slice(0, 120),
            })
            .select(
                "id, title, agent_instruction, source_message_id, source_excerpt, created_at",
            )
            .single();
        if (error) return void sendInternalError(res, error);
        return void res.json(created);
    }

    const projectId = parsedProjectId.value.projectId;
    const projectAccess = await validateAccessibleProjectId(
        projectId,
        userId,
        userEmail,
        db,
    );
    if (!projectAccess.ok)
        return void res
            .status(projectAccess.status)
            .json({ detail: projectAccess.detail });

    const { data, error } = await db
        .from("chats")
        .insert({ user_id: userId, project_id: projectId ?? null })
        .select("id")
        .single();

    if (error) return void sendInternalError(res, error);
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const chat = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });

    const { data: messages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    const hydrated = await hydrateEditStatuses(
        withoutEmptyAssistantReservations(messages ?? []),
        db,
    );
    res.json({ chat, messages: hydrated });
});

// Stored doc_edited events capture the `status` at the time the assistant
// produced the edit (always "pending"). If the user later accepts or rejects,
// `document_edits.status` is updated but the stored event is not. On chat load
// we merge the current DB status in so EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string") versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// GET /chat/:chatId/agents
//
// The dock rebuilds from this on every load. Status is derived here rather
// than stored, because the only durable fact is what the agent's messages
// contain; whether a stream is open is a property of a live connection, so the
// client overlays "Processing" itself and an interrupted agent reads as
// "empty" with a rerun affordance.
chatRouter.get("/:chatId/agents", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const chat = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });

    const { data: agentRows, error } = await db
        .from("chats")
        .select(
            "id, title, agent_instruction, source_message_id, source_excerpt, created_at",
        )
        .eq("parent_chat_id", chatId)
        .order("created_at", { ascending: true });
    if (error) return void sendInternalError(res, error);

    const agents = (agentRows ?? []) as {
        id: string;
        title: string | null;
        agent_instruction: string | null;
        source_message_id: string | null;
        source_excerpt: string | null;
        created_at: string;
    }[];
    if (agents.length === 0) return void res.json([]);

    // One query for every agent's messages, grouped in memory — a per-agent
    // round trip would multiply the cost of the dock by the agent cap.
    const { data: messageRows } = await db
        .from("chat_messages")
        .select("chat_id, role, content, created_at")
        .in(
            "chat_id",
            agents.map((agent) => agent.id),
        )
        .order("created_at", { ascending: true });

    const byChat = new Map<string, Record<string, unknown>[]>();
    for (const row of (messageRows ?? []) as Record<string, unknown>[]) {
        const key = String(row.chat_id ?? "");
        const list = byChat.get(key);
        if (list) list.push(row);
        else byChat.set(key, [row]);
    }

    res.json(
        agents.map((agent) => {
            const messages = byChat.get(agent.id) ?? [];
            return {
                ...agent,
                status: deriveChatAgentStatus(messages),
                pending_proposals: countPendingEditProposals(messages),
            };
        }),
    );
});

// PATCH /chat/:chatId/messages/:messageId
//
// Rewrites one assistant message's stored events. Used when the user accepts
// an agent's proposed edit: the client applies the replacement to the message
// it is looking at and sends the result back. Access is `getAccessibleChat` —
// the same derivation that gates sending into this chat — so anyone who could
// have continued the conversation can revise it, and nobody else can.
chatRouter.patch(
    "/:chatId/messages/:messageId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { chatId, messageId } = req.params;
        const parsedContent = parseAssistantMessageContent(req.body?.content);
        if (!parsedContent.ok) {
            return void res.status(400).json({ detail: parsedContent.detail });
        }

        const db = createServerSupabase();
        const chat = await getAccessibleChat(chatId, userId, userEmail, db);
        if (!chat)
            return void res.status(404).json({ detail: "Chat not found" });

        const { data, error } = await db
            .from("chat_messages")
            .update({
                content: parsedContent.value,
                edited_at: new Date().toISOString(),
            })
            .eq("id", messageId)
            .eq("chat_id", chatId)
            // Only assistant prose is revisable. A user's own message is a
            // record of what they said, not a draft.
            .eq("role", "assistant")
            .select("id, content, edited_at")
            .maybeSingle();

        if (error) return void sendInternalError(res, error);
        if (!data)
            return void res.status(404).json({ detail: "Message not found" });
        res.json(data);
    },
);

// PATCH /chat/:chatId/proposals/:proposalId
//
// Marks one proposal accepted or rejected. `:chatId` is the agent's own chat —
// the proposal lives in the message the agent produced, so resolving it is a
// write to that message's events, not to the parent response.
chatRouter.patch(
    "/:chatId/proposals/:proposalId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { chatId, proposalId } = req.params;
        const status = req.body?.status;
        if (status !== "accepted" && status !== "rejected") {
            return void res
                .status(400)
                .json({ detail: 'status must be "accepted" or "rejected"' });
        }

        const db = createServerSupabase();
        const chat = await getAccessibleChat(chatId, userId, userEmail, db);
        if (!chat)
            return void res.status(404).json({ detail: "Chat not found" });

        const { data: messages, error } = await db
            .from("chat_messages")
            .select("id, content")
            .eq("chat_id", chatId)
            .eq("role", "assistant")
            .order("created_at", { ascending: true });
        if (error) return void sendInternalError(res, error);

        for (const message of (messages ?? []) as {
            id: string;
            content: unknown;
        }[]) {
            const next = setEditProposalStatus(
                message.content,
                proposalId,
                status,
            );
            if (!next) continue;
            const { error: updateError } = await db
                .from("chat_messages")
                .update({ content: next })
                .eq("id", message.id)
                .eq("chat_id", chatId);
            if (updateError) return void sendInternalError(res, updateError);
            return void res.json({ proposal_id: proposalId, status });
        }

        res.status(404).json({ detail: "Proposal not found" });
    },
);

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const invalidField = Object.keys(body).find(
        (field) =>
            field !== "title" &&
            field !== "model" &&
            field !== "reasoningLevel",
    );
    if (invalidField) {
        return void res
            .status(400)
            .json({ detail: `Unsupported chat field: ${invalidField}` });
    }
    const hasTitle = Object.hasOwn(body, "title");
    const hasModel = Object.hasOwn(body, "model");
    const hasReasoning = Object.hasOwn(body, "reasoningLevel");
    if (!hasTitle && !hasModel && !hasReasoning) {
        return void res
            .status(400)
            .json({ detail: "title, model, or reasoningLevel is required" });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (hasTitle && !title) {
        return void res.status(400).json({ detail: "title is required" });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (hasModel && !parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(body.reasoningLevel);
    if (hasReasoning && !parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }

    const db = createServerSupabase();
    const chat = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!chat || (hasTitle && chat.user_id !== userId)) {
        return void res.status(404).json({ detail: "Chat not found" });
    }

    let selectedModel: string | undefined;
    const selectedReasoningLevel =
        hasReasoning && parsedReasoning.ok ? parsedReasoning.value : undefined;
    if (hasModel) {
        const settings = await getUserModelSettings(userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: parsedModel.ok ? parsedModel.value : undefined,
            chatModel: chat.model,
            lastSelectedModel: settings.last_selected_chat_model,
            apiKeys: settings.api_keys,
            userId,
            db,
        });
        if (!resolution.ok) {
            return void res.status(resolution.status).json({
                code: resolution.code,
                detail: resolution.detail,
            });
        }
        selectedModel = resolution.model;
    }

    const update = {
        ...(hasTitle ? { title } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedReasoningLevel
            ? { reasoning_level: selectedReasoningLevel }
            : {}),
    };
    const { data, error } = await db
        .from("chats")
        .update(update)
        .eq("id", chatId)
        .select("id, title, model, reasoning_level")
        .single();

    if (error || !data)
        return void res.status(404).json({ detail: "Chat not found" });

    if (selectedModel) {
        const profileError = await persistLastSelectedChatModel(
            userId,
            selectedModel,
            db,
        );
        if (profileError) return void sendInternalError(res, profileError);
    }
    if (selectedReasoningLevel) {
        const profileError = await persistLastSelectedReasoningLevel(
            userId,
            selectedReasoningLevel,
            db,
        );
        if (profileError) return void sendInternalError(res, profileError);
    }
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
        .from("chats")
        .delete()
        .eq("id", chatId)
        .eq("user_id", userId);

    if (error) return void sendInternalError(res, error);
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message =
        typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const requestedModel =
        typeof req.body?.model === "string" ? req.body.model.trim() : null;
    if (!message)
        return void res.status(400).json({ detail: "message is required" });
    const db = createServerSupabase();
    const chat = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });

    try {
        const settings = await getUserModelSettings(userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: requestedModel,
            chatModel: chat.model,
            lastSelectedModel: settings.last_selected_chat_model,
            apiKeys: settings.api_keys,
            userId,
            db,
        });
        if (!resolution.ok) {
            return void res.status(resolution.status).json({
                code: resolution.code,
                detail: resolution.detail,
            });
        }
        const title = await generateAssistantChatTitle({
            model: titleModelForChat(resolution.model, settings.title_model),
            message,
            apiKeys: settings.api_keys,
        });

        await db.from("chats").update({ title }).eq("id", chatId);

        res.json({ title });
    } catch (err) {
        console.error("[generate-title]", err);
        res.status(500).json({ detail: "Failed to generate title" });
    }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
    const parsedMessages = parseChatMessages(body.messages);
    if (!parsedMessages.ok) {
        return void res.status(400).json({ detail: parsedMessages.detail });
    }
    const parsedChatId = parseOptionalChatId(body.chat_id);
    if (!parsedChatId.ok) {
        return void res.status(400).json({ detail: parsedChatId.detail });
    }
    const parsedProjectId = parseOptionalProjectId(body.project_id);
    if (!parsedProjectId.ok) {
        return void res.status(400).json({ detail: parsedProjectId.detail });
    }
    const parsedModel = parseOptionalModel(body.model);
    if (!parsedModel.ok) {
        return void res.status(400).json({ detail: parsedModel.detail });
    }
    const parsedReasoning = parseOptionalReasoning(body.reasoning);
    if (!parsedReasoning.ok) {
        return void res.status(400).json({ detail: parsedReasoning.detail });
    }
    const parsedAskInputsResponse = parseOptionalAskInputsResponse(
        body.ask_inputs_response,
    );
    if (!parsedAskInputsResponse.ok) {
        return void res
            .status(400)
            .json({ detail: parsedAskInputsResponse.detail });
    }
    const messages = parsedMessages.value;
    const chat_id = parsedChatId.value;
    const project_id = parsedProjectId.value.projectId;
    const model = parsedModel.value;
    const askInputsResponse = parsedAskInputsResponse.value;
    // Reserve a stable assistant identity before streaming. This lets clients
    // associate streamed UI with the same durable message after a reload.
    const assistantMessageId = askInputsResponse ? null : randomUUID();

    devLog("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        messageCount: messages?.length,
    });

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;
    let resolvedProjectId: string | null = parsedProjectId.value.projectId;
    // Set only when this turn belongs to an assigned agent. It is what unlocks
    // the propose_edit tool and the agent's role prompt; every other chat runs
    // exactly as before.
    let agentChat: AccessibleChat | null = null;

    if (chatId) {
        const existing = await getAccessibleChat(chatId, userId, userEmail, db);
        if (!existing)
            return void res.status(404).json({ detail: "Chat not found" });
        if (existing.parent_chat_id) agentChat = existing;

        const existingProjectId = existing.project_id ?? null;
        if (
            parsedProjectId.value.provided &&
            parsedProjectId.value.projectId !== existingProjectId
        ) {
            return void res
                .status(400)
                .json({ detail: "project_id does not match chat" });
        }
        resolvedProjectId = existingProjectId;
        chatTitle = existing.title;
        chatModel = existing.model;
        chatReasoningLevel = existing.reasoning_level;
    }

    const modelSettings = await getUserModelSettings(userId, db);
    const modelResolution = await resolveEffectiveChatModel({
        requested: model,
        chatModel,
        lastSelectedModel: modelSettings.last_selected_chat_model,
        apiKeys: modelSettings.api_keys,
        userId,
        db,
    });
    if (!modelResolution.ok) {
        return void res.status(modelResolution.status).json({
            code: modelResolution.code,
            detail: modelResolution.detail,
        });
    }
    const selectedModel = modelResolution.model;
    const selectedReasoningLevel = resolveEffectiveReasoningLevel({
        model: selectedModel,
        requested: parsedReasoning.value,
        chatReasoningLevel,
        lastSelectedReasoningLevel: modelSettings.last_selected_reasoning_level,
    });

    if (
        chatId &&
        (chatModel !== selectedModel ||
            chatReasoningLevel !== selectedReasoningLevel)
    ) {
        const { error } = await db
            .from("chats")
            .update({
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .eq("id", chatId);
        if (error) return void sendInternalError(res, error);
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        const projectAccess = await validateAccessibleProjectId(
            resolvedProjectId,
            userId,
            userEmail,
            db,
        );
        if (!projectAccess.ok)
            return void res
                .status(projectAccess.status)
                .json({ detail: projectAccess.detail });

        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: resolvedProjectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    if (!chatId) {
        return void res
            .status(500)
            .json({ detail: "Failed to initialize chat" });
    }

    devLog("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (askInputsResponse) {
        await appendAskInputsResponseToLastAssistantMessage(
            db,
            chatId,
            askInputsResponse,
        );
    } else if (lastUser) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
        });
    }

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        db,
        chatId,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    // Generate the nonce before enriching prior events so document filenames
    // and workflow titles replayed from earlier turns are fenced as well.
    const nonce = generateSpotlightNonce();
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
        nonce,
    );
    const {
        api_keys: apiKeys,
        legal_research_us: legalResearchUs,
        title_model: titleModel,
        personalisation,
    } = modelSettings;
    const personalisationPrompt = buildUserPersonalisationPrompt(
        personalisation,
        nonce,
    );
    const systemPromptExtra =
        [
            personalisationPrompt,
            agentChat ? buildChatAgentSystemPrompt(agentChat) : "",
        ]
            .filter(Boolean)
            .join("\n\n") || undefined;
    const apiMessages = buildMessages(
        enrichedMessages,
        docAvailability,
        systemPromptExtra,
        undefined,
        legalResearchUs,
        nonce,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    devLog("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    // Make the advertised identity durable before the response becomes an
    // SSE stream. If this reservation fails, return a normal HTTP error while
    // headers are still mutable; clients must never receive an ID that cannot
    // subsequently be loaded from chat history.
    if (assistantMessageId) {
        const reserveError = await reserveAssistantMessage({
            db,
            table: "chat_messages",
            id: assistantMessageId,
            chatId,
        });
        if (reserveError) {
            console.error(
                "[chat/stream] failed to reserve assistant message",
                reserveError,
            );
            return void res
                .status(500)
                .json({ detail: "Failed to start assistant response" });
        }
    }

    const stream = openAssistantSse(res);
    const write = stream.write;
    const updateReservedAssistantMessage =
        createReservedAssistantMessageUpdater({
            db,
            table: "chat_messages",
            id: assistantMessageId ?? "",
            chatId,
            enabled: !!assistantMessageId,
        });

    try {
        write(
            `data: ${JSON.stringify({
                type: "chat_id",
                chatId,
                ...(assistantMessageId ? { assistantMessageId } : {}),
            })}\n\n`,
        );

        const shouldGenerateTitle =
            !chatTitle && !!lastUser?.content && !askInputsResponse;
        const titleMessage = lastUser
            ? [
                  lastUser.content,
                  lastUser.workflow
                      ? `Workflow: ${lastUser.workflow.title}`
                      : "",
                  lastUser.files?.length
                      ? `Files: ${lastUser.files.map((file) => file.filename).join(", ")}`
                      : "",
              ]
                  .filter(Boolean)
                  .join("\n")
            : "";
        const titlePromise = shouldGenerateTitle
            ? generateAssistantChatTitle({
                  model: titleModelForChat(selectedModel, titleModel),
                  message: titleMessage,
                  apiKeys,
              })
                  .then(async (title) => {
                      const { error } = await db
                          .from("chats")
                          .update({ title })
                          .eq("id", chatId);
                      if (error) throw error;
                      chatTitle = title;
                      if (!stream.signal.aborted) {
                          write(
                              `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                          );
                      }
                  })
                  .catch((error) => {
                      console.error(
                          "[chat/stream] failed to generate chat title",
                          error,
                      );
                  })
            : Promise.resolve();

        const { fullText, events, citations } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            workflowStore,
            includeResearchTools: legalResearchUs,
            model: selectedModel,
            reasoning: selectedReasoningLevel,
            // An agent's thread renders in a narrow side panel with a plain
            // composer, which has no ask_inputs picker to answer with. Offer
            // the tool only where the answer can actually be given.
            includeAskInputs: !agentChat,
            routeTools: agentChat
                ? createEditProposalToolsAdapter()
                : undefined,
            apiKeys,
            signal: stream.signal,
            projectId: resolvedProjectId,
            nonce,
            // This route first makes the advertised assistant ID durable.
            // It emits [DONE] only after the reserved row has been populated.
            emitDone: false,
        });

        devLog("[chat/stream] LLM stream finished", {
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        });

        // Upstream providers occasionally end the stream cleanly but empty
        // (observed via OpenRouter). Silence reads as a hung composer, so
        // surface it — unless tools produced visible artifacts, which carry
        // their own completion signal.
        if (
            !fullText?.trim() &&
            (!events || events.every((event) => !("error" in event)))
        ) {
            write(
                `data: ${JSON.stringify({
                    type: "error",
                    message:
                        "The model returned an empty response. Try again, or pick a different model.",
                    safe_to_display: true,
                })}\n\n`,
            );
            write("data: [DONE]\n\n");
            return;
        }

        const persistedEvents = stripTransientAssistantEvents(events);
        if (askInputsResponse) {
            await appendAssistantEventsToLastAssistantMessage(
                db,
                chatId,
                persistedEvents,
                citations,
            );
        } else {
            const saveError = await updateReservedAssistantMessage(
                persistedEvents.length ? persistedEvents : null,
                citations.length ? citations : null,
            );
            if (saveError) {
                console.error(
                    "[chat/stream] failed to save assistant response",
                    saveError,
                );
                write(
                    `data: ${JSON.stringify({
                        type: "error",
                        message:
                            "The response was generated but could not be saved.",
                    })}\n\n`,
                );
                write("data: [DONE]\n\n");
                return;
            }
        }

        await titlePromise;

        if (!chatTitle && lastUser?.content) {
            const title = lastUser.content.slice(0, 120);
            await db.from("chats").update({ title }).eq("id", chatId);
            chatTitle = title;
            if (shouldGenerateTitle && !stream.signal.aborted) {
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }
        void enqueueChatTurnAudit(
            db,
            {
                userId,
                userEmail,
                chatId,
                projectId: resolvedProjectId,
                title: chatTitle ?? lastUser?.content?.slice(0, 120) ?? null,
                model: selectedModel,
            },
            persistedEvents,
        );
        write("data: [DONE]\n\n");
    } catch (err) {
        if (isAbortError(err)) {
            devLog("[chat/stream] client aborted stream", { chatId });
            void enqueueChatTurnAudit(
                db,
                {
                    userId,
                    userEmail,
                    chatId,
                    projectId: resolvedProjectId,
                    title: chatTitle,
                    model: selectedModel,
                    status: "cancelled",
                },
                null,
            );
            if (err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractCitations(fullText, docIndex),
                });
                const saveError = askInputsResponse
                    ? null
                    : await updateReservedAssistantMessage(
                          partial.events.length ? partial.events : null,
                          partial.citations.length ? partial.citations : null,
                      );
                if (askInputsResponse) {
                    await appendAssistantEventsToLastAssistantMessage(
                        db,
                        chatId,
                        partial.events,
                        partial.citations,
                    );
                }
                if (saveError) {
                    console.error(
                        "[chat/stream] failed to save aborted stream",
                        saveError,
                    );
                }
            }
            return;
        }
        console.error("[chat/stream] error:", err);
        const message = ASSISTANT_ERROR_MESSAGE;
        const errorEvents =
            err instanceof AssistantStreamError
                ? stripTransientAssistantEvents(err.events)
                : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        try {
            const citations = extractCitations(errorFullText, docIndex);
            const saveError = askInputsResponse
                ? null
                : await updateReservedAssistantMessage(
                      errorEvents.length ? errorEvents : null,
                      citations.length ? citations : null,
                  );
            if (askInputsResponse) {
                await appendAssistantEventsToLastAssistantMessage(
                    db,
                    chatId,
                    errorEvents,
                    citations,
                );
            }
            if (saveError)
                console.error("[chat/stream] failed to save error", saveError);
        } catch (saveErr) {
            console.error("[chat/stream] failed to save error", saveErr);
        }
        try {
            write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        stream.finish();
    }
});
