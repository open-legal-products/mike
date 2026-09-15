// Chat support for the tabular module: the review-chat records themselves
// (list, delete, patch, messages), the prepare/persist halves of the streaming
// chat endpoint, parsing the model's <CITATIONS> block into typed annotations,
// and building the system + history messages the agentic review chat streams
// over. The streaming loop itself stays in tabular.routes.ts.

import {
    parseOptionalModel,
    parseOptionalReasoning,
    type ChatMessage,
    type TabularCellStore,
} from "../chat/chat.service";
import { type ReasoningLevel, type UserApiKeys } from "../../lib/llm";
import { randomUUID } from "node:crypto";
import {
    checkProjectAccess,
    creatorScopedAllowed,
    ensureReviewAccess,
    projectHasSharedAudience,
} from "../../lib/access";
import { can } from "../../lib/permissions";
import { hasDirectContentGrants } from "../../lib/contentAccess";
import {
    beginMemoryConversationTurn,
    type MemoryConversationTurn,
} from "../../lib/memory/schedule";
import {
    failure,
    internalFailure,
    type ServiceFailure,
} from "../../lib/serviceResult";
import {
    getUserModelSettings,
    resolveUserChatSelection,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
} from "../user/user.service";
import {
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../../lib/modelSelection";
import { generateChatTitle } from "./tabular.extract";
import { loadReviewRows } from "./tabular.rows";
import {
    parseCellContent,
    statusFailure,
    type Db,
    type TabularResult,
} from "./tabular.shared";

// ---------------------------------------------------------------------------
// Tabular citation parsing
// ---------------------------------------------------------------------------

export type TabularParsedCitation = {
    ref: number;
    col_index: number;
    row_index: number;
    quote: string;
};

const TABULAR_CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;

export function parseTabularCitations(text: string): TabularParsedCitation[] {
    const match = text.match(TABULAR_CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        return JSON.parse(match[1]) as TabularParsedCitation[];
    } catch {
        return [];
    }
}

export function extractTabularAnnotations(
    fullText: string,
    tabularStore: TabularCellStore,
) {
    return parseTabularCitations(fullText).map((c) => ({
        type: "tabular_citation" as const,
        ref: c.ref,
        col_index: c.col_index,
        row_index: c.row_index,
        col_name:
            tabularStore.columns[c.col_index]?.name ?? `Col ${c.col_index}`,
        doc_name:
            tabularStore.documents[c.row_index]?.filename ??
            `Row ${c.row_index}`,
        quote: c.quote,
    }));
}

// ---------------------------------------------------------------------------
// Build messages for tabular chat
// ---------------------------------------------------------------------------

export function buildTabularMessages(
    messages: ChatMessage[],
    tabularStore: TabularCellStore,
    reviewTitle: string,
): unknown[] {
    const docList = tabularStore.documents
        .map((d, i) => `- ROW:${i} "${d.filename}"`)
        .join("\n");
    const colList = tabularStore.columns
        .map((c, i) => `- COL:${i} "${c.name}"`)
        .join("\n");

    const systemContent = `You are Mike, an AI legal assistant. You are helping with the tabular review titled "${reviewTitle}".

The review extracts specific fields from multiple legal documents into a structured table.
You do NOT have the cell content yet — call read_table_cells to fetch the cells you need before answering.

DOCUMENTS (rows):
${docList || "- (none)"}

COLUMNS (fields):
${colList || "- (none)"}

TABULAR CITATION INSTRUCTIONS:
When you reference specific cell content, place a numbered marker [1], [2], etc. inline in your prose at the point of reference.

After your complete response, append a <CITATIONS> block containing a JSON array with one entry per marker:

<CITATIONS>
[
  {"ref": 1, "col_index": 0, "row_index": 2, "quote": "verbatim text from the cell"},
  {"ref": 2, "col_index": 1, "row_index": 0, "quote": "another excerpt"}
]
</CITATIONS>

Rules:
- col_index and row_index are 0-based (matching the COL/ROW numbers listed above)
- Only cite cells you have read via read_table_cells
- quote should be verbatim text from the cell's summary
- Omit <CITATIONS> if you make no citations
- Do not fabricate cell content
- Answer in clear, concise prose. You may use markdown formatting.`;

    const formatted: unknown[] = [{ role: "system", content: systemContent }];
    for (const msg of messages) {
        formatted.push({ role: msg.role, content: msg.content ?? "" });
    }
    return formatted;
}

// ---------------------------------------------------------------------------
// Chat records
// ---------------------------------------------------------------------------
//
// Listing, deleting and patching a review's chat threads, plus the two halves
// the streaming POST /:reviewId/chat endpoint needs: everything before the
// first SSE byte (`prepareTabularChat`) and the writes that happen after the
// stream ends. The stream loop itself stays in the route — it is the one place
// that legitimately owns `res`.

export type ReviewChatSummary = {
    id: string;
    title: string | null;
    model: string | null;
    reasoning_level: string | null;
    created_at: string;
    updated_at: string;
    user_id: string;
};

export async function listTabularReviewChats(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<TabularResult<ReviewChatSummary[]>> {
    const { reviewId, userId, userEmail } = args;

    // Verify access (creator, direct grant, project access, or org).
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .single();
    if (error || !review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Review not found");

    // Show every member's chats for the review (collaborative), not just
    // the requester's. Per-chat access is gated above by review access.
    const { data: chats } = await db
        .from("tabular_review_chats")
        .select(
            "id, title, model, reasoning_level, created_at, updated_at, user_id",
        )
        .eq("review_id", reviewId)
        .order("updated_at", { ascending: false });

    return { ok: true, data: (chats ?? []) as ReviewChatSummary[] };
}

// Review-chat writes share one preamble: the caller must be able to access
// the review named in the URL, and the chat must actually belong to it —
// previously these two writes checked neither, so any chat id could be hit
// through any (or a nonexistent) review path.
async function ensureReviewChatWriteAccess(
    db: Db,
    reviewId: string,
    chatId: string,
    userId: string,
    userEmail: string | null | undefined,
): Promise<{ ok: true } | ServiceFailure> {
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .single();
    if (!review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Review not found");
    const { data: chat } = await db
        .from("tabular_review_chats")
        .select("id, review_id, user_id")
        .eq("id", chatId)
        .single();
    if (!chat || chat.review_id !== reviewId)
        return failure("not_found", "Chat not found");
    // Review chats are creator-write: collaborators read each other's
    // threads but cannot rename or delete them. Refusing here, not via the
    // write's user_id filter alone, keeps a non-creator from getting a
    // success-shaped 204 for an update that silently matched zero rows.
    //
    // `creatorScopedAllowed` rather than a bare `chat.user_id !== userId`,
    // because `tabular_review_chats.user_id` is ON DELETE SET NULL since
    // 20260902_01: once the author's account is deleted the column is NULL
    // and "only the creator may act" means NOBODY may act — the thread is
    // stranded inside a review the organization still owns, which is the
    // opposite of what detaching the row was for. When the creator is gone
    // the container's admins inherit the operation; while a creator exists
    // nothing changes, and an admin still may not touch a colleague's live
    // thread.
    if (
        !creatorScopedAllowed(
            {
                // "isCreator" is about THIS chat. `access` was derived for
                // the REVIEW, and the review's creator is not thereby the
                // creator of every chat inside it — passing `access` whole
                // would hand them everyone's threads.
                isCreator: !!chat.user_id && chat.user_id === userId,
                projectRole: access.projectRole,
            },
            chat.user_id,
        )
    )
        return failure("forbidden", "Only the chat's creator can modify it");
    return { ok: true };
}

export async function deleteTabularReviewChat(
    db: Db,
    args: {
        reviewId: string;
        chatId: string;
        userId: string;
        userEmail: string | undefined;
    },
): Promise<TabularResult<null>> {
    const { reviewId, chatId, userId, userEmail } = args;
    const gate = await ensureReviewChatWriteAccess(
        db,
        reviewId,
        chatId,
        userId,
        userEmail,
    );
    if (!gate.ok) return gate;
    // Scoped by the binding the gate just proved (this chat, in this
    // review) and nothing more. A `user_id` filter here would be a
    // second, weaker copy of the authorization rule: it would silently
    // match zero rows for the case the gate now allows — an admin
    // clearing up after a departed colleague — and answer 204 while
    // deleting nothing.
    const { error } = await db
        .from("tabular_review_chats")
        .delete()
        .eq("id", chatId)
        .eq("review_id", reviewId);
    if (error) return internalFailure(error);
    return { ok: true, data: null };
}

export async function updateTabularReviewChat(
    db: Db,
    args: {
        reviewId: string;
        chatId: string;
        userId: string;
        userEmail: string | undefined;
        body: Record<string, unknown>;
    },
): Promise<TabularResult<Record<string, unknown>>> {
    const { reviewId, chatId, userId, userEmail, body } = args;

    const invalidField = Object.keys(body).find(
        (field) =>
            field !== "title" && field !== "model" && field !== "reasoningLevel",
    );
    if (invalidField) {
        return failure("validation", `Unsupported chat field: ${invalidField}`);
    }
    const hasTitle = Object.hasOwn(body, "title");
    const hasModel = Object.hasOwn(body, "model");
    const hasReasoning = Object.hasOwn(body, "reasoningLevel");
    if (!hasTitle && !hasModel && !hasReasoning) {
        return failure(
            "validation",
            "title, model, or reasoningLevel is required",
        );
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (hasTitle && !title) return failure("validation", "title is required");
    const parsedModel = parseOptionalModel(body.model);
    if (hasModel && !parsedModel.ok)
        return failure("validation", parsedModel.detail);
    const parsedReasoning = parseOptionalReasoning(body.reasoningLevel);
    if (hasReasoning && !parsedReasoning.ok)
        return failure("validation", parsedReasoning.detail);

    const gate = await ensureReviewChatWriteAccess(
        db,
        reviewId,
        chatId,
        userId,
        userEmail,
    );
    if (!gate.ok) return gate;
    // Scoped by chat + review only — mirrors the delete above.
    const { data: chat, error: chatError } = await db
        .from("tabular_review_chats")
        .select("id, model")
        .eq("id", chatId)
        .eq("review_id", reviewId)
        .single();
    if (chatError || !chat) return failure("not_found", "Chat not found");

    let selectedModel: string | undefined;
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
        if (!resolution.ok)
            return statusFailure(resolution.status, {
                code: resolution.code,
                detail: resolution.detail,
            });
        selectedModel = resolution.model;
    }
    const selectedReasoningLevel =
        hasReasoning && parsedReasoning.ok ? parsedReasoning.value : undefined;
    const update = {
        ...(hasTitle ? { title: title.slice(0, 200) } : {}),
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(selectedReasoningLevel
            ? { reasoning_level: selectedReasoningLevel }
            : {}),
        updated_at: new Date().toISOString(),
    };
    const { data, error } = await db
        .from("tabular_review_chats")
        .update(update)
        .eq("id", chatId)
        .eq("review_id", reviewId)
        .select("id, title, model, reasoning_level")
        .single();
    if (error || !data) return failure("not_found", "Chat not found");

    if (selectedModel) {
        const profileError = await persistLastSelectedChatModel(
            userId,
            selectedModel,
            db,
        );
        if (profileError) return internalFailure(profileError);
    }
    if (selectedReasoningLevel) {
        const profileError = await persistLastSelectedReasoningLevel(
            userId,
            selectedReasoningLevel,
            db,
        );
        if (profileError) return internalFailure(profileError);
    }
    return { ok: true, data: data as Record<string, unknown> };
}

export async function listTabularReviewChatMessages(
    db: Db,
    args: {
        reviewId: string;
        chatId: string;
        userId: string;
        userEmail: string | undefined;
    },
): Promise<TabularResult<Record<string, unknown>[]>> {
    const { reviewId, chatId, userId, userEmail } = args;

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .single();
    if (!review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Review not found");

    const { data: chat, error: chatError } = await db
        .from("tabular_review_chats")
        .select("id, review_id")
        .eq("id", chatId)
        .single();
    if (chatError || !chat || chat.review_id !== reviewId)
        return failure("not_found", "Chat not found");

    const { data: messages } = await db
        .from("tabular_review_chat_messages")
        .select("id, role, content, annotations, created_at")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    return { ok: true, data: (messages ?? []) as Record<string, unknown>[] };
}

// ---------------------------------------------------------------------------
// The streaming chat endpoint's non-streaming halves
// ---------------------------------------------------------------------------

export type PreparedTabularChat = {
    /** The review's stored title, for the first-exchange title prompt. */
    reviewTitle: string | null;
    tabularStore: TabularCellStore;
    /** Null only if chat creation was skipped; the stream still runs. */
    chatId: string | null;
    chatTitle: string | null;
    isFirstExchange: boolean;
    model: string;
    reasoningLevel: ReasoningLevel;
    /** The model that names a new chat, already resolved for this chat model. */
    titleModel: string;
    apiKeys: UserApiKeys;
    apiMessages: unknown[];
    /** The id of the user turn just persisted — the assistant row links back
     *  to it through `memory_input_message_id`. */
    inputMessageId: string;
    /** The project whose memory may be READ into this turn's prompt. */
    readableMemoryProjectId: string | null;
    /** The project whose memory this turn may CURATE, if any. */
    writableMemoryProjectId: string | null;
    memorySharedAudience: boolean;
    /** The durable activity fence; the route releases it unless the turn
     *  ends up scheduling consolidation. */
    memoryTurn: MemoryConversationTurn | null;
};

/**
 * Everything POST /:reviewId/chat does before its first SSE byte: load the
 * review and its grid, resolve or create the chat row, settle the model and
 * reasoning level, persist the user's message, and build the prompt.
 *
 * It runs as one unit because the order matters — the chat row must exist
 * before the user message is stored, and the model must be settled before the
 * chat row records it — and because a failure anywhere in it is still an
 * ordinary JSON error response; once the route starts streaming, it can only
 * report failures as SSE frames.
 */
export async function prepareTabularChat(
    db: Db,
    args: {
        reviewId: string;
        userId: string;
        userEmail: string | undefined;
        messages: ChatMessage[];
        lastUserContent: string;
        /** Continue this thread when it is the caller's and this review's. */
        chatId: string | undefined;
        requestedModel: string | undefined;
        requestedReasoning: string | undefined;
    },
): Promise<TabularResult<PreparedTabularChat>> {
    const {
        reviewId,
        userId,
        userEmail,
        messages,
        lastUserContent,
        requestedModel,
        requestedReasoning,
    } = args;

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review) return failure("not_found", "Review not found");
    const reviewAccess = await ensureReviewAccess(review, userId, userEmail, db);
    if (!reviewAccess.ok || !can(reviewAccess.projectRole, "content.edit"))
        return failure("not_found", "Review not found");

    // A direct review grant does not grant access to the containing project.
    // Keep project memory behind the project's own capability verdict: view
    // may read it, while only a project editor may curate it.
    let readableMemoryProjectId: string | null = null;
    let writableMemoryProjectId: string | null = null;
    let memorySharedAudience =
        !reviewAccess.isCreator ||
        (await hasDirectContentGrants(db, "tabular_review", review.id));
    if (review.project_id) {
        const projectAccess = await checkProjectAccess(
            review.project_id,
            userId,
            userEmail,
            db,
        );
        if (projectAccess.ok) {
            readableMemoryProjectId = review.project_id;
            memorySharedAudience =
                memorySharedAudience ||
                (await projectHasSharedAudience(
                    db,
                    review.project_id,
                    projectAccess.project.org_id,
                ));
            if (can(projectAccess.projectRole, "content.edit")) {
                writableMemoryProjectId = review.project_id;
            }
        }
    }

    // Fetch all cells and logical review rows for this review.
    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const rows = await loadReviewRows(db, reviewId);

    const sortedColumns = (
        (review.columns_config ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        columns: sortedColumns,
        documents: rows.map((row) => ({
            id: row.id,
            filename: row.label,
        })),
        cells: new Map(
            (cells ?? []).map((c: any) => [
                `${c.column_index}:${c.row_id}`,
                parseCellContent(c.content),
            ]),
        ),
    };

    // Create or verify chat record
    let chatId = args.chatId ?? null;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;
    const isFirstExchange =
        messages.filter((m) => m.role === "user").length === 1;

    if (chatId) {
        // The chat must belong to this exact review and to the requester.
        // Review access alone is not enough: otherwise a user could reuse one
        // of their chats from a different review in this route.
        const { data: existing } = await db
            .from("tabular_review_chats")
            .select("id, title, model, reasoning_level, review_id, user_id")
            .eq("id", chatId)
            .single();
        const canUse =
            !!existing &&
            existing.review_id === reviewId &&
            existing.user_id === userId;
        if (!canUse || !existing) chatId = null;
        else {
            chatTitle = existing.title;
            chatModel = existing.model;
            chatReasoningLevel = existing.reasoning_level;
        }
    }

    const selection = await resolveUserChatSelection(db, {
        userId,
        chatModel,
        chatReasoningLevel,
        requestedModel,
        requestedReasoning,
    });
    if (!selection.ok)
        return statusFailure(selection.status, {
            code: selection.code,
            detail: selection.detail,
        });
    const {
        modelSettings,
        selectedModel: selectedChatModel,
        selectedReasoningLevel,
    } = selection;

    if (
        chatId &&
        (chatModel !== selectedChatModel ||
            chatReasoningLevel !== selectedReasoningLevel)
    ) {
        const { error: updateError } = await db
            .from("tabular_review_chats")
            .update({
                model: selectedChatModel,
                reasoning_level: selectedReasoningLevel,
                updated_at: new Date().toISOString(),
            })
            .eq("id", chatId)
            .eq("review_id", reviewId)
            .eq("user_id", userId);
        if (updateError) return internalFailure(updateError);
    }

    if (!chatId) {
        const { data: newChat, error: newChatError } = await db
            .from("tabular_review_chats")
            .insert({
                review_id: reviewId,
                user_id: userId,
                model: selectedChatModel,
                reasoning_level: selectedReasoningLevel,
            })
            .select("id, title")
            .single();
        if (newChatError || !newChat)
            return statusFailure(500, { detail: "Failed to create chat" });
        chatId = newChat?.id ?? null;
        chatTitle = newChat?.title ?? null;
    }

    let memoryTurn: MemoryConversationTurn | null = null;
    const inputMessageId = randomUUID();

    // Persist user message
    if (chatId) {
        const { error: userMessageError } = await db
            .from("tabular_review_chat_messages")
            .insert({
                id: inputMessageId,
                chat_id: chatId,
                role: "user",
                content: lastUserContent,
                author_user_id: userId,
            });
        if (userMessageError) return internalFailure(userMessageError);
    }

    if (chatId) {
        try {
            memoryTurn = await beginMemoryConversationTurn({
                db,
                surface: "tabular",
                conversationId: chatId,
                actorUserId: userId,
            });
        } catch (turnError) {
            return internalFailure(turnError);
        }
    }

    const apiMessages = buildTabularMessages(
        messages,
        tabularStore,
        review.title || "Untitled Review",
    );

    return {
        ok: true,
        data: {
            reviewTitle: (review.title as string | null) ?? null,
            tabularStore,
            chatId,
            chatTitle,
            isFirstExchange,
            model: selectedChatModel,
            reasoningLevel: selectedReasoningLevel,
            titleModel: titleModelForChat(
                selectedChatModel,
                modelSettings.title_model,
            ),
            apiKeys: modelSettings.api_keys,
            apiMessages,
            inputMessageId,
            readableMemoryProjectId,
            writableMemoryProjectId,
            memorySharedAudience,
            memoryTurn,
        },
    };
}

/**
 * Store one assistant turn, and optionally bump the chat's `updated_at` so the
 * list orders by most recent activity.
 *
 * `touch` has three settings because the three terminal paths differ:
 * "when-saved" is the success path, which only counts a durably stored turn as
 * activity (and whose `saved` verdict also gates memory consolidation);
 * "always" is the client-abort path, which floats the partial turn regardless;
 * "never" is the error path — a stream that failed still records what it
 * managed to produce, but that is not activity the chat list should float.
 *
 * Returns the insert error rather than throwing, because every caller is
 * already inside a stream's terminal handling and can only log.
 *
 * `messageId` is generated by the caller: the memory pipeline links the
 * assistant row to the user turn that produced it, and identifies the turn it
 * consolidated, so both ids must be known before the row exists.
 */
export async function saveTabularChatTurn(
    db: Db,
    args: {
        chatId: string;
        messageId: string;
        authorUserId: string;
        memoryInputMessageId: string;
        content: unknown[];
        annotations: unknown[];
        touch: "when-saved" | "always" | "never";
    },
): Promise<{ saved: boolean; error: unknown }> {
    const { error } = await db.from("tabular_review_chat_messages").insert({
        id: args.messageId,
        chat_id: args.chatId,
        role: "assistant",
        content: args.content.length ? args.content : null,
        annotations: args.annotations.length ? args.annotations : null,
        author_user_id: args.authorUserId,
        memory_input_message_id: args.memoryInputMessageId,
    });
    const saved = !error;
    if (args.touch === "always" || (args.touch === "when-saved" && saved)) {
        await db
            .from("tabular_review_chats")
            .update({ updated_at: new Date().toISOString() })
            .eq("id", args.chatId);
    }
    return { saved, error };
}

/**
 * Name a chat from its first user message and persist the title. Returns the
 * title so the caller can announce it on the stream, or null when the model
 * declined to produce one (the chat simply stays untitled).
 */
export async function titleTabularChat(
    db: Db,
    args: {
        chatId: string;
        titleModel: string;
        userContent: string;
        reviewTitle: string | null;
        projectName: string | null;
        apiKeys: UserApiKeys;
    },
): Promise<string | null> {
    const title = await generateChatTitle(
        args.titleModel,
        args.userContent,
        { reviewTitle: args.reviewTitle, projectName: args.projectName },
        args.apiKeys,
    );
    if (!title) return null;
    await db
        .from("tabular_review_chats")
        .update({ title })
        .eq("id", args.chatId);
    return title;
}
