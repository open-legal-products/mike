import type { Response } from "express";

/**
 * Server-owned assistant turns.
 *
 * A turn is the generation of one assistant answer. Before this module the
 * generation lived inside the HTTP response that requested it: the SSE
 * socket closing (a refresh, a closed tab, a dropped connection) aborted the
 * model call, and the backend persisted whatever had arrived as "Cancelled by
 * user." Now the turn is a *run* registered here. The route still drives the
 * generation, but it writes frames into the run's buffer instead of the
 * socket, and any number of responses can attach to the run: the original
 * request, a reload of the same chat, a second tab. A response attaching late
 * gets the buffered frames replayed from the sequence number it last saw,
 * then tails the live ones. Closing a response detaches it and nothing else;
 * only `stop()` (the explicit Stop endpoint) aborts the generation.
 *
 * Frames keep their wire form (`data: <json>\n\n`) and gain an SSE `id:`
 * line carrying the sequence number, which is what a client sends back as
 * `from` when it reconnects.
 *
 * Scope: one process. A run lives in this process's memory, so a resume has
 * to reach the replica that is generating (single replica, or sticky
 * routing). A finished run is kept for a short grace period so a client that
 * reconnects just after the end still receives the terminal frames.
 */

export const FINISHED_RUN_RETENTION_MS = 60_000;
/** A safety net, not a feature: the tool loop is bounded, but a hung provider is not. */
export const MAX_RUN_LIFETIME_MS = 30 * 60_000;

type Frame = { seq: number; line: string };

type Subscriber = {
  write: (chunk: string) => void;
  end: () => void;
};

export type AssistantTurnRun = {
  readonly id: string;
  readonly chatId: string;
  readonly userId: string;
  /** The assistant row the answer is (or will be) stored in. */
  readonly assistantMessageId: string;
  readonly startedAt: number;
  /** Aborted by `stop()` only. Hand this to the model call. */
  readonly signal: AbortSignal;
  readonly seq: number;
  readonly finished: boolean;
  readonly stopped: boolean;
  /** Append one SSE record (`data: ...\n\n`) and fan it out. */
  write: (line: string) => boolean;
  /** The generation is over: end every attached response and start the retention clock. */
  finish: () => void;
  /** Explicit cancel: abort the generation. The route persists the partial answer. */
  stop: () => void;
  /**
   * Replay frames with `seq >= from`, then tail. The subscriber is ended when
   * the run finishes. Returns the detach function.
   */
  subscribe: (from: number, subscriber: Subscriber) => () => void;
};

type RunRecord = AssistantTurnRun & {
  frames: Frame[];
  subscribers: Set<Subscriber>;
  controller: AbortController;
  retention: ReturnType<typeof setTimeout> | null;
  lifetime: ReturnType<typeof setTimeout> | null;
};

const runs = new Map<string, RunRecord>();
const activeByChat = new Map<string, RunRecord>();

function frameChunk(frame: Frame): string {
  return `id: ${frame.seq}\n${frame.line}`;
}

function remove(run: RunRecord) {
  if (run.retention) clearTimeout(run.retention);
  if (run.lifetime) clearTimeout(run.lifetime);
  runs.delete(run.id);
  if (activeByChat.get(run.chatId) === run) activeByChat.delete(run.chatId);
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
}): AssistantTurnRun | null {
  const current = activeByChat.get(args.chatId);
  if (current && !current.finished) return null;
  const controller = new AbortController();
  let seq = 0;
  let finished = false;
  let stopped = false;
  const run: RunRecord = {
    id: args.id,
    chatId: args.chatId,
    userId: args.userId,
    assistantMessageId: args.assistantMessageId,
    startedAt: Date.now(),
    signal: controller.signal,
    get seq() {
      return seq;
    },
    get finished() {
      return finished;
    },
    get stopped() {
      return stopped;
    },
    frames: [],
    subscribers: new Set(),
    controller,
    retention: null,
    lifetime: null,
    write(line: string) {
      if (finished) return false;
      seq += 1;
      const frame = { seq, line };
      run.frames.push(frame);
      const chunk = frameChunk(frame);
      for (const subscriber of [...run.subscribers]) {
        try {
          subscriber.write(chunk);
        } catch {
          run.subscribers.delete(subscriber);
        }
      }
      return true;
    },
    finish() {
      if (finished) return;
      finished = true;
      if (activeByChat.get(run.chatId) === run) activeByChat.delete(run.chatId);
      for (const subscriber of [...run.subscribers]) {
        try {
          subscriber.end();
        } catch {
          /* the response is gone either way */
        }
      }
      run.subscribers.clear();
      if (run.lifetime) clearTimeout(run.lifetime);
      run.lifetime = null;
      run.retention = setTimeout(() => remove(run), FINISHED_RUN_RETENTION_MS);
      run.retention.unref?.();
    },
    stop() {
      if (finished || stopped) return;
      stopped = true;
      controller.abort();
    },
    subscribe(from: number, subscriber: Subscriber) {
      for (const frame of run.frames) {
        if (frame.seq >= from) subscriber.write(frameChunk(frame));
      }
      if (finished) {
        subscriber.end();
        return () => {};
      }
      run.subscribers.add(subscriber);
      return () => {
        run.subscribers.delete(subscriber);
      };
    },
  };
  run.lifetime = setTimeout(() => run.stop(), MAX_RUN_LIFETIME_MS);
  run.lifetime.unref?.();
  runs.set(run.id, run);
  activeByChat.set(run.chatId, run);
  return run;
}

export function getAssistantTurnRun(turnId: string): AssistantTurnRun | undefined {
  return runs.get(turnId);
}

/** What a client reloading the chat needs in order to attach. */
export function getActiveAssistantTurn(chatId: string): {
  id: string;
  seq: number;
  assistant_message_id: string;
} | null {
  const run = activeByChat.get(chatId);
  if (!run || run.finished) return null;
  return { id: run.id, seq: run.seq, assistant_message_id: run.assistantMessageId };
}

/**
 * Stream a run into an Express response as SSE, from `from` onwards, and end
 * the response when the run finishes. Closing the response only detaches.
 *
 * Returns the same `{ signal, write, finish }` shape `openAssistantSse` gives
 * the streaming routes, so a route that starts a run drives the generation
 * through the run without changing anything else: `write` buffers and fans
 * out, `signal` is the run's (Stop, not socket close), `finish` ends the run.
 */
export function attachAssistantTurnSse(
  res: Response,
  run: AssistantTurnRun,
  from = 1,
): { signal: AbortSignal; write: (line: string) => boolean; finish: () => void } {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let ended = false;
  const detach = run.subscribe(from, {
    write: (chunk) => {
      if (ended || res.writableEnded) return;
      res.write(chunk);
    },
    end: () => {
      if (ended) return;
      ended = true;
      res.end();
    },
  });
  res.on("close", () => {
    ended = true;
    detach();
  });

  return {
    signal: run.signal,
    write: run.write,
    finish: run.finish,
  };
}

/** Test hook: forget every run. */
export function resetAssistantTurnRunsForTests() {
  for (const run of [...runs.values()]) remove(run);
  activeByChat.clear();
}
