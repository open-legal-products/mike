import type { Response } from "express";
import {
    attachStreamRunSse,
    getActiveStreamRun,
    getStreamRun,
    resetStreamRunsForTests,
    startStreamRun,
    type StreamRun,
} from "./streamRuns";

/**
 * Server-owned assistant turns.
 *
 * A turn is the generation of one assistant answer. Before this module the
 * generation lived inside the HTTP response that requested it: the SSE
 * socket closing (a refresh, a closed tab, a dropped connection) aborted the
 * model call, and the backend persisted whatever had arrived as "Cancelled by
 * user." Now the turn is a *run* registered in `streamRuns.ts`, the generic
 * registry tabular generation uses as well. The route still drives the
 * generation, but it writes frames into the run's buffer instead of the
 * socket, and any number of responses can attach to the run: the original
 * request, a reload of the same chat, a second tab. A response attaching late
 * gets the buffered frames replayed from the sequence number it last saw,
 * then tails the live ones. Closing a response detaches it and nothing else;
 * only `stop()` (the explicit Stop endpoint) aborts the generation.
 *
 * This file is the chat-shaped view of a run: the key is `<surface>:<chatId>`
 * (so a chat may have one turn at a time), and the assistant row the answer
 * is stored in travels in the run's `meta`. Everything else — the frame
 * buffer, the `id:` sequence numbers, the retention and lifetime windows, the
 * SSE attachment — lives in `streamRuns.ts`.
 */

export { FINISHED_RUN_RETENTION_MS, MAX_RUN_LIFETIME_MS } from "./streamRuns";

/**
 * Which kind of thread the turn belongs to. It only namespaces the run key,
 * so a chat and a tabular-review thread with the same id cannot collide.
 */
export type AssistantTurnSurface = "chat" | "tabular" | "word";

/**
 * What the run carries for the surface that owns it. `chatId` and
 * `assistantMessageId` are common to every surface; the rest is Word's, whose
 * resume endpoints authorise from the run itself because a LOCAL Word chat
 * has no database row to authorise against.
 */
type TurnMeta = {
    chatId: string;
    assistantMessageId: string;
    /** Word only: the embedded document the pane is attached to. */
    clientDocumentId?: string;
    /** Word only: false for a local (never-persisted) chat. */
    persistChat?: boolean;
};

export type AssistantTurnRun = StreamRun<TurnMeta> & {
    readonly chatId: string;
    /** The assistant row the answer is (or will be) stored in. */
    readonly assistantMessageId: string;
};

const turnKey = (chatId: string, surface: AssistantTurnSurface = "chat") =>
    `${surface}:${chatId}`;

/**
 * The chat-shaped view of a run, created once per run so callers can compare
 * identities (`getAssistantTurnRun(id) === run`).
 */
const views = new WeakMap<StreamRun<TurnMeta>, AssistantTurnRun>();

function turnView(run: StreamRun<TurnMeta>): AssistantTurnRun {
    const existing = views.get(run);
    if (existing) return existing;
    const view = Object.create(run, {
        chatId: { get: () => run.meta.chatId, enumerable: true },
        assistantMessageId: {
            get: () => run.meta.assistantMessageId,
            enumerable: true,
        },
    }) as AssistantTurnRun;
    views.set(run, view);
    return view;
}

/**
 * Register a run for a chat. Returns null when a run is already generating
 * into that chat: two concurrent writers on one thread would interleave
 * their rows, and the client refuses this too, so the server refuses it for
 * the tab that did not know.
 */
export function startAssistantTurnRun(args: {
    id: string;
    chatId: string;
    userId: string;
    assistantMessageId: string;
    surface?: AssistantTurnSurface;
    /** Word only: what its resume endpoints authorise against. */
    clientDocumentId?: string;
    /** Word only: false for a local (never-persisted) chat. */
    persistChat?: boolean;
}): AssistantTurnRun | null {
    const run = startStreamRun<TurnMeta>({
        id: args.id,
        key: turnKey(args.chatId, args.surface),
        userId: args.userId,
        meta: {
            chatId: args.chatId,
            assistantMessageId: args.assistantMessageId,
            ...(args.clientDocumentId !== undefined
                ? { clientDocumentId: args.clientDocumentId }
                : {}),
            ...(args.persistChat !== undefined
                ? { persistChat: args.persistChat }
                : {}),
        },
    });
    return run ? turnView(run) : null;
}

/**
 * The turn with this id, if it belongs to `surface`.
 *
 * The surface check matters because a turn id is only unique within this
 * process, not within a surface: without it, a tabular review chat could hand
 * `/chats/:chatId/turn/:turnId/stream` the id of a WEB chat turn that happens
 * to carry the same `chatId`, and the caller would attach to a thread the
 * tabular access check never looked at.
 */
export function getAssistantTurnRun(
    turnId: string,
    surface: AssistantTurnSurface = "chat",
): AssistantTurnRun | undefined {
    const run = getStreamRun<TurnMeta>(turnId);
    if (!run || run.key !== turnKey(run.meta.chatId, surface)) return undefined;
    return turnView(run);
}

/** What a client reloading the chat needs in order to attach. */
export function getActiveAssistantTurn(
    chatId: string,
    surface?: AssistantTurnSurface,
): {
    id: string;
    seq: number;
    assistant_message_id: string;
} | null {
    const run = getActiveStreamRun<TurnMeta>(turnKey(chatId, surface));
    if (!run || run.finished) return null;
    return {
        id: run.id,
        seq: run.seq,
        assistant_message_id: run.meta.assistantMessageId,
    };
}

/**
 * Stream a turn into an Express response as SSE, from `from` onwards, and end
 * the response when the turn finishes. Closing the response only detaches.
 *
 * Returns the same `{ signal, write, finish }` shape `openAssistantSse` gives
 * the streaming routes, so a route that starts a turn drives the generation
 * through the run without changing anything else.
 */
export function attachAssistantTurnSse(
    res: Response,
    run: AssistantTurnRun,
    from = 1,
): {
    signal: AbortSignal;
    write: (line: string) => boolean;
    finish: () => void;
} {
    return attachStreamRunSse(res, run, from);
}

/** Test hook: forget every run. */
export function resetAssistantTurnRunsForTests() {
    resetStreamRunsForTests();
}
