"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useRouter } from "next/navigation";
import { stopChatTurn, streamChat, streamProjectChat } from "@/app/lib/mikeApi";
import {
  createTurnCursor,
  createTurnEventSink,
  isAbortError,
  readAssistantTurn,
} from "@/app/lib/assistantTurnStream";
import {
  beginAssistantTurn,
  cancelAssistantTurn,
  getAssistantTurn,
  hasAssistantTurn,
  loadAssistantChat,
  subscribeAssistantTurns,
  withLiveTurn,
  type AssistantTurnHandle,
  type LiveAssistantTurn,
} from "@/app/lib/assistantTurns";
import { assistantHistoryContent } from "@/app/lib/assistantHistoryContent";
import { reportError } from "@/app/lib/errorReporting";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import {
  UserVisibleError,
  describeError,
  notifyError,
  notifyInfo,
} from "@/app/lib/userFacingError";
import type { AssistantEvent, Message } from "@/app/components/shared/types";

interface UseAssistantChatOptions {
  initialMessages?: Message[];
  chatId?: string;
  projectId?: string;
  /** Adopts the server id as soon as it arrives, without navigation. */
  onChatCreated?: (chatId: string) => void;
  /**
   * Whether this is the chat the app shell treats as current (the sidebar's
   * highlighted row). False for a chat shown beside the primary one.
   */
  tracksCurrentChat?: boolean;
}


export function useAssistantChat({
  initialMessages = [],
  chatId: initialChatId,
  projectId,
  onChatCreated,
  tracksCurrentChat = true,
}: UseAssistantChatOptions = {}) {
  const router = useRouter();
  const {
    replaceChatId,
    loadChats,
    setCurrentChatId: setHistoryCurrentChatId,
    saveChat,
    setNewChatMessages,
    updateChatTitle,
  } = useChatHistoryContext();
  const setCurrentChatId = (id: string | null) => {
    if (tracksCurrentChat) setHistoryCurrentChatId(id);
  };

  const [messages, setRawMessages] = useState<Message[]>(initialMessages);
  // Mirrors `messages` for the async send path: a turn started from a toast
  // Retry runs long after the render that raised it.
  const messagesRef = useRef<Message[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [isResponseLoading, setIsResponseLoading] = useState(false);
  // An object, not a bare model id: an ask-inputs response submits without a
  // model, and a null id has to still open the popup — the id only decides
  // whether the provider can be named.
  const [rejectedApiKey, setRejectedApiKey] = useState<{
    model: string | null;
  } | null>(null);
  const [isLoadingCitations, setIsLoadingCitations] = useState(false);
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);
  // Mirrors `chatId` for the async send path. A turn started from a toast
  // Retry runs long after the render that raised it, and the state value
  // captured by that render is the one from *before* the stream assigned the
  // chat its id — sending it would create a second chat for the same turn.
  const chatIdRef = useRef<string | undefined>(initialChatId);

  useEffect(() => {
    chatIdRef.current = initialChatId;
    setChatId(initialChatId);
  }, [initialChatId]);

  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const viewedChatId = initialChatId ?? chatId;
  const pendingTurn = useSyncExternalStore(
    subscribeAssistantTurns,
    () => hasAssistantTurn(viewedChatId),
    () => false,
  );
  const abortControllerRef = useRef<AbortController | null>(null);
  const registeredTurnRef = useRef<AssistantTurnHandle | null>(null);
  const requestGenerationRef = useRef(0);

  // The turn this hook renders. While it streams, every change to its
  // assistant message is mirrored into `messages`; whichever hook is looking
  // at the thread — the one that sent the request, or one that came back to
  // it — shows the same live answer. Once the turn has finished the record
  // stays attached until the thread changes, so a history read that started
  // before the answer was stored cannot erase it from the screen.
  const attachedTurnRef = useRef<LiveAssistantTurn | null>(null);
  const unsubscribeTurnRef = useRef<(() => void) | null>(null);
  const attachToTurn = useCallback((live: LiveAssistantTurn | null) => {
    if (live === attachedTurnRef.current) return;
    unsubscribeTurnRef.current?.();
    unsubscribeTurnRef.current = null;
    attachedTurnRef.current = live;
    if (!live) return;
    const mirror = () => {
      setRawMessages((prev) => withLiveTurn(prev, live));
      setIsLoadingCitations(live.loadingCitations);
      if (live.finished) {
        unsubscribeTurnRef.current?.();
        unsubscribeTurnRef.current = null;
      }
    };
    unsubscribeTurnRef.current = live.subscribe(mirror);
    mirror();
  }, []);
  // Hosts replace the transcript when a thread's history arrives. The turn
  // in flight is laid over whatever they set, so the answer streaming into
  // this thread is never displaced by a snapshot taken before it was stored.
  const setMessages: Dispatch<SetStateAction<Message[]>> = useCallback(
    (action) => {
      setRawMessages((prev) =>
        withLiveTurn(
          typeof action === "function" ? action(prev) : action,
          attachedTurnRef.current,
        ),
      );
    },
    [],
  );
  useEffect(() => {
    const sync = () => {
      const live = getAssistantTurn(viewedChatId);
      if (live) attachToTurn(live);
    };
    sync();
    const unsubscribe = subscribeAssistantTurns((id) => {
      if (id === viewedChatId) sync();
    });
    return () => {
      unsubscribe();
      attachToTurn(null);
    };
  }, [viewedChatId, attachToTurn]);

  // Invalidate the previous request before a new thread can receive updates.
  //
  // Keyed on the thread itself, never on effect lifecycle. StrictMode replays
  // create/destroy/create on mount without the thread changing, and doing this
  // in a cleanup aborted a request the host had just started: a first message
  // auto-sent from a mount effect was killed mid-flight, and because the catch
  // ignores a superseded request the turn stalled on its empty placeholder with
  // no error. A layout effect still runs inside the switching commit, so no
  // async continuation from the old request can land in the new thread first.
  const threadKey = `${projectId ?? ""}:${initialChatId ?? ""}`;
  const threadKeyRef = useRef(threadKey);
  const adoptedThreadKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (threadKeyRef.current === threadKey) return;
    threadKeyRef.current = threadKey;
    const isAdoptedThread = adoptedThreadKeyRef.current === threadKey;
    adoptedThreadKeyRef.current = null;
    // A new chat receiving its persisted id is still the same live turn.
    if (isAdoptedThread) return;
    // Detach — never abort. Aborting closes the socket, which the backend
    // treats as Stop: it persists a truncated "Cancelled by user." answer in
    // the thread the user just left. Retiring the generation is enough to
    // keep the old turn from writing into the new thread; the request itself
    // runs to completion and the server stores the whole answer.
    requestGenerationRef.current += 1;
    abortControllerRef.current = null;
    registeredTurnRef.current = null;
    attachToTurn(null);
    setIsResponseLoading(false);
    setIsLoadingCitations(false);
  }, [threadKey, attachToTurn]);

  /**
   * Stop listening to the turn in flight without cancelling it. For leaving a
   * thread (switching chats, starting a new one): the request keeps running,
   * the turn record keeps collecting the answer for whoever views the thread
   * next, and the server persists the complete answer. Only `cancel` — the
   * Stop control — aborts the request.
   */
  const detach = () => {
    requestGenerationRef.current += 1;
    abortControllerRef.current = null;
    registeredTurnRef.current = null;
    attachToTurn(null);
    setIsResponseLoading(false);
    setIsLoadingCitations(false);
  };

  /** Stop: this hook's own request, or the detached one streaming into the thread it views. */
  const cancel = () => {
    const own = registeredTurnRef.current;
    if (own) {
      own.cancel();
      return;
    }
    cancelAssistantTurn(viewedChatId);
  };

  type ChatTurnOptions = {
    displayedDoc?: { filename: string; documentId: string } | null;
    askInputsResponse?: Extract<
      AssistantEvent,
      { type: "ask_inputs_response" }
    >;
  };

  /**
   * Everything a re-send needs, captured when the turn is sent. An error
   * toast with actions never auto-dismisses, so its Retry can fire minutes
   * later — by then the hook may be showing a different thread, a newer turn
   * may own the stream, and the chat may have been given an id. The snapshot
   * (not the raising render's closure, and not a mutable "last turn") is what
   * the retry replays, and it is validated against the live hook first.
   */
  type TurnSnapshot = {
    /** The request generation this turn owned; a newer one supersedes it. */
    turnId: number;
    /** Project + chat the turn was sent from; updated when the id arrives. */
    threadKey: string;
    /** The chat id the turn ended up in, once the stream assigns one. */
    chatId: string | undefined;
    message: Message;
    opts?: ChatTurnOptions;
    /** Messages on screen when the turn was sent, minus its own answer. */
    transcriptLength: number;
    /**
     * The user bubble this turn answers: normally the message itself, or —
     * for an ask-inputs continuation, whose answer is rendered as an event
     * rather than a bubble — the question already on screen.
     */
    anchorContent: string;
    /**
     * Set when the connection broke after the server had named the turn.
     * The server owns that run: it is still generating, or has stored the
     * answer. Retry re-reads the thread rather than re-sending the question,
     * which would store it twice (and, while the run is alive, be refused
     * with 409 turn_in_progress after that insert).
     */
    recoveryChatId?: string;
  };

  const threadKeyFor = (id: string | undefined) =>
    `${projectId ?? ""}:${id ?? "new"}`;

  const lastUserMessage = (transcript: Message[]): Message | undefined => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (transcript[i].role === "user") return transcript[i];
    }
    return undefined;
  };

  /**
   * Re-send one specific turn. Refuses — visibly, but without touching the
   * transcript or an in-flight stream — when the hook has moved on from the
   * turn the toast was raised for.
   */
  const retryTurn = async (turn: TurnSnapshot): Promise<string | null> => {
    if (!mountedRef.current) {
      notifyInfo("Open this chat and wait for its current answer before retrying.");
      return null;
    }
    const transcript = messagesRef.current;
    const anchor = lastUserMessage(transcript);
    // The host swaps threads by writing straight through the setters, so the
    // hook can be showing another chat entirely by the time this fires.
    if (turn.threadKey !== threadKeyFor(chatIdRef.current)) {
      notifyInfo(
        "This chat has changed. Send the message again from the chat it belongs to.",
      );
      return null;
    }
    if (turn.turnId !== requestGenerationRef.current) {
      // A newer turn owns the thread. Re-sending would abort a healthy
      // stream and answer a question the user has already moved past.
      notifyInfo(
        "A newer message has replaced this one. Send it again if you still need an answer.",
      );
      return null;
    }
    if (
      transcript.length < turn.transcriptLength ||
      !anchor ||
      anchor.content !== turn.anchorContent
    ) {
      // Same chat id, different transcript: the thread was reloaded or
      // rewritten under the toast.
      notifyInfo(
        "This chat has changed. Send the message again from the chat it belongs to.",
      );
      return null;
    }
    if (hasAssistantTurn(chatIdRef.current)) {
      notifyInfo("Wait for this chat's current answer before retrying.");
      return null;
    }
    if (turn.recoveryChatId) return recoverServerTurn(turn, turn.recoveryChatId);
    // Drop the failed assistant bubble before re-sending, or the retry would
    // stack a second empty turn under it and repeat the user's question in
    // the request. `messagesRef` is updated here too so `handleChat` reads
    // the trimmed list without waiting for a React commit. The finished turn
    // record is detached first, or `setMessages` would lay the failed answer
    // back over the trimmed list.
    const trimmed = [...transcript];
    while (
      trimmed.length > 0 &&
      trimmed[trimmed.length - 1].role === "assistant"
    ) {
      trimmed.pop();
    }
    attachToTurn(null);
    messagesRef.current = trimmed;
    setMessages(trimmed);
    return handleChat(turn.message, turn.opts);
  };

  /**
   * Retry for a turn the server already owns: show the server's copy of the
   * thread. `loadAssistantChat` re-attaches to the run if it is still
   * generating (the hook then mirrors it like any resumed turn) and otherwise
   * returns the stored answer. Reading is idempotent, so a second click
   * cannot double anything.
   */
  const recoverServerTurn = async (
    turn: TurnSnapshot,
    serverChatId: string,
  ): Promise<string | null> => {
    attachToTurn(null);
    try {
      const loaded = await loadAssistantChat(serverChatId);
      // Same staleness rules as a re-send: never repaint a thread the user
      // has since left or sent into.
      if (
        !mountedRef.current ||
        turn.turnId !== requestGenerationRef.current ||
        chatIdRef.current !== serverChatId
      ) {
        return null;
      }
      setMessages(loaded.messages);
      return serverChatId;
    } catch (error) {
      notifyError(error, {
        action: "load this chat",
        dedupeKey: "assistant-chat",
          support: true,
        onRetry: async () => {
          await retryTurn(turn);
        },
      });
      return null;
    }
  };

  const handleChat = async (
    message: Message,
    opts?: ChatTurnOptions,
  ): Promise<string | null> => {
    if (!message.content.trim() || hasAssistantTurn(chatIdRef.current)) return null;

    setIsResponseLoading(true);

    // The committed list, or the one a retry just trimmed.
    const currentMessages = messagesRef.current;
    const lastMessage = currentMessages[currentMessages.length - 1];
    const isMessageAlreadyAdded =
      lastMessage &&
      lastMessage.role === "user" &&
      lastMessage.content === message.content;

    const apiMessagesForTurn: Message[] = isMessageAlreadyAdded
      ? currentMessages
      : [...currentMessages, message];
    const askInputsResponseEvent = opts?.askInputsResponse ?? null;
    const optimisticResponseEvent = askInputsResponseEvent;
    const userInputThinkingEvent = optimisticResponseEvent
      ? ({
          type: "thinking" as const,
          isStreaming: true,
        } satisfies AssistantEvent)
      : null;
    const displayMessages: Message[] = optimisticResponseEvent
      ? (() => {
          const updated = currentMessages.map((item) => ({
            ...item,
            events: item.events ? [...item.events] : item.events,
          }));
          for (let i = updated.length - 1; i >= 0; i--) {
            const current = updated[i];
            if (current.role !== "assistant") continue;
            updated[i] = {
              ...current,
              events: [
                ...(current.events ?? []),
                optimisticResponseEvent,
                ...(userInputThinkingEvent ? [userInputThinkingEvent] : []),
              ],
            };
            return updated;
          }
          return updated;
        })()
      : apiMessagesForTurn;

    // An ask-inputs answer continues the assistant message that asked;
    // anything else starts a fresh one.
    const continuedAssistant = optimisticResponseEvent
      ? ([...displayMessages]
          .reverse()
          .find((item) => item.role === "assistant") ?? null)
      : null;
    const assistantPlaceholder: Message = continuedAssistant ?? {
      role: "assistant",
      content: "",
      citations: [],
      events: [],
    };
    setRawMessages(
      optimisticResponseEvent
        ? displayMessages
        : [...displayMessages, assistantPlaceholder],
    );

    const generation = ++requestGenerationRef.current;
    const retrySnapshot: TurnSnapshot = {
      turnId: generation,
      threadKey: threadKeyFor(chatIdRef.current),
      chatId: chatIdRef.current,
      message,
      opts,
      transcriptLength: optimisticResponseEvent
        ? displayMessages.length
        : apiMessagesForTurn.length,
      anchorContent:
        lastUserMessage(
          optimisticResponseEvent ? displayMessages : apiMessagesForTurn,
        )?.content ?? message.content,
    };
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const isCurrentRequest = () =>
      mountedRef.current && requestGenerationRef.current === generation;
    // The live id, never the render-time state this closure captured: a turn
    // re-sent from a toast must land in the chat the first attempt created,
    // not open a second one.
    const sendChatId = chatIdRef.current;
    const cursor = createTurnCursor(sendChatId);
    // From here the turn record owns the assistant message; this hook, like
    // any hook that comes back to the thread, renders it by attaching.
    const turn = beginAssistantTurn(sendChatId, {
      userMessage: optimisticResponseEvent ? null : message,
      assistant: assistantPlaceholder,
      cancel: () => {
        // The server keeps generating until it is told otherwise: closing
        // this connection only detaches. Name the turn to the Stop endpoint
        // first, then stop reading. Before the first frame the turn has no
        // name yet; the server then finishes the answer on its own and
        // stores it whole, which a reload shows.
        if (cursor.chatId && cursor.turnId) {
          void stopChatTurn(cursor.chatId, cursor.turnId).catch(() => {});
        }
        controller.abort();
        sink.appendCancellation();
        turn.finish();
        if (isCurrentRequest()) {
          setIsResponseLoading(false);
          setIsLoadingCitations(false);
        }
      },
    });
    const sink = createTurnEventSink(turn, assistantPlaceholder.events ?? []);
    registeredTurnRef.current = turn;
    attachToTurn(turn.turn);
    let streamedChatId: string | null = null;

    try {
      const apiMessages = apiMessagesForTurn.map((currentMessage) => ({
        role: currentMessage.role,
        content:
          currentMessage.role === "assistant"
            ? assistantHistoryContent(currentMessage)
            : currentMessage.content,
        files: currentMessage.files,
        workflow: currentMessage.workflow,
      }));

      const model = message.model;
      const reasoning = message.reasoning;

      const displayedDoc = opts?.displayedDoc ?? null;

      // Pull the user's attachments from the just-submitted message.
      // These are the files dragged into / picked from the chat input
      // for this turn (separate from the running history of past
      // attachments). Sent as a request-level field so the backend
      // can call them out specifically in the system prompt.
      const attachedDocs = (
        message.files?.filter((f) => !!f.document_id) ?? []
      ).map((f) => ({
        filename: f.filename,
        document_id: f.document_id as string,
      }));

      // The frames go to the turn record (lib/assistantTurnStream), which
      // every hook viewing the thread mirrors. Only this hook's own state
      // and navigation are gated on the request still being its own; a
      // dropped connection is resumed from the server's copy of the turn.
      await readAssistantTurn({
        open: () =>
          projectId
            ? streamProjectChat({
                projectId,
                messages: apiMessages,
                chat_id: sendChatId,
                model,
                reasoning,
                displayed_doc: displayedDoc
                  ? {
                      filename: displayedDoc.filename,
                      document_id: displayedDoc.documentId,
                    }
                  : undefined,
                attached_documents:
                  attachedDocs.length > 0 ? attachedDocs : undefined,
                ask_inputs_response: opts?.askInputsResponse,
                signal: controller.signal,
              })
            : streamChat({
                messages: apiMessages,
                chat_id: sendChatId,
                model,
                reasoning,
                ask_inputs_response: opts?.askInputsResponse,
                signal: controller.signal,
              }),
        turn,
        sink,
        cursor,
        signal: controller.signal,
        hooks: {
          onChatId: (streamed) => {
            const isNewChatId =
              streamed !== sendChatId && streamed !== streamedChatId;
            streamedChatId = streamed;
            if (!isCurrentRequest()) return;
            chatIdRef.current = streamed;
            // Keep this turn's snapshot on the chat it actually landed in,
            // so its Retry re-sends into that chat instead of creating one.
            retrySnapshot.chatId = streamed;
            retrySnapshot.threadKey = threadKeyFor(streamed);
            setChatId(streamed);
            setCurrentChatId(streamed);
            if (isNewChatId && onChatCreated) {
              adoptedThreadKeyRef.current = `${projectId ?? ""}:${streamed}`;
              onChatCreated(streamed);
            }
          },
          onChatTitle: (id, title) => updateChatTitle(id, title),
          // A rejected key cannot be fixed by retrying, so raise it as a
          // signal the surface can turn into "go fix your key" rather than
          // leaving it as one more line of failed-response text.
          onRejectedApiKey: () => {
            if (isCurrentRequest()) setRejectedApiKey({ model: model ?? null });
          },
          onErrorFrame: ({ message: frameMessage, safeToDisplay }) => {
            // The bubble records that this turn failed; the toast is where
            // the user gets a way back. A server-side failure is one the
            // user cannot fix, so Contact support rides along with Retry.
            //
            // A `safe_to_display` frame is a configuration refusal (no API
            // key, a model this deployment disallows): re-sending it would
            // fail identically, so it gets support without a Retry.
            notifyError(
              new UserVisibleError(
                safeToDisplay
                  ? frameMessage
                  : "Mike couldn't finish this answer. Try again.",
                { kind: "server", retryable: !safeToDisplay },
              ),
              {
                action: "get a response",
                dedupeKey: "assistant-chat",
          support: true,
                onRetry: async () => {
                  await retryTurn(retrySnapshot);
                },
              },
            );
            if (isCurrentRequest()) setIsResponseLoading(false);
          },
        },
      });

      if (!isCurrentRequest()) return null;

      setIsResponseLoading(false);
      setIsLoadingCitations(false);

      const finalChatId = streamedChatId || sendChatId || null;
      if (finalChatId && finalChatId !== sendChatId) {
        if (sendChatId) {
          replaceChatId(
            sendChatId,
            finalChatId,
            message.content.trim().slice(0, 120) || "New Chat",
          );
        }
        setCurrentChatId(finalChatId);
        if (!onChatCreated) {
          const chatBasePath = projectId
            ? `/projects/${projectId}/assistant/chat`
            : `/assistant/chat`;
          router.replace(`${chatBasePath}/${finalChatId}`);
        }
      }

      await loadChats();

      return streamedChatId || null;
    } catch (error: unknown) {
      // The record learns of the failure even when this hook no longer
      // renders the thread: a reader attached to the turn must see the
      // error, not a spinner.
      sink.finalizeStreamingContent();
      if (controller.signal.aborted || isAbortError(error)) {
        sink.finalizeStreamingReasoning();
        sink.appendCancellation();
      } else {
        // The stream broke for a reason other than the user stopping it:
        // the user sees a generic message, Sentry gets the real one.
        reportError(error, {
          tags: { component: "assistant-chat", project: Boolean(projectId) },
        });
        sink.endStreamingAfterFailure();
        if (cursor.chatId && cursor.turnId) {
          retrySnapshot.recoveryChatId = cursor.chatId;
        }
        const described = describeError(error, {
          action: "get a response",
          fallback: "Mike couldn't finish this answer. Try again.",
        });
        // A lost response is not proof the POST failed. Until a turn is
        // named, only an explicit 4xx refusal permits a new send.
        const uncertain = !retrySnapshot.recoveryChatId &&
          (described.status === null || described.status >= 500);
        const failure = uncertain
          ? new UserVisibleError(
              "The answer may still be running. Check chat history before sending the question again.",
              { cause: error },
            )
          : error;
        if (uncertain && retrySnapshot.chatId) {
          retrySnapshot.recoveryChatId = retrySnapshot.chatId;
        }
        turn.update((assistantMessage) => ({
          ...assistantMessage,
          error: uncertain ? (failure as UserVisibleError).message : described.message,
        }));
        notifyError(failure, {
          action: "get a response",
          fallback: "Mike couldn't finish this answer. Try again.",
          dedupeKey: "assistant-chat",
          support: true,
          onRetry: uncertain ? undefined : async () => { await retryTurn(retrySnapshot); },
          actions: uncertain ? [{
            label: retrySnapshot.chatId ? "Check chat" : "Refresh history",
            onClick: async () => {
              if (retrySnapshot.chatId) await retryTurn(retrySnapshot);
              else await loadChats();
            },
          }] : undefined,
        });
      }

      if (!isCurrentRequest()) return null;
      setIsResponseLoading(false);
      setIsLoadingCitations(false);
      return null;
    } finally {
      turn.finish();
      if (registeredTurnRef.current === turn) registeredTurnRef.current = null;
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  };

  const handleNewChat = async (
    message: Message,
    projectId?: string,
  ): Promise<string | null> => {
    if (!message.content.trim()) return null;

    setRawMessages([message]);
    setNewChatMessages([message]);

    const newChatId = await saveChat(projectId);
    if (newChatId) {
      chatIdRef.current = newChatId;
      setChatId(newChatId);
      setCurrentChatId(newChatId);
    }

    return newChatId;
  };

  return {
    messages,
    /**
     * Set when a provider rejected our API key on the last send. `model` is
     * the model we asked for, or null when the send carried none. Retrying
     * cannot help, so surfaces use this to point at the key instead.
     */
    rejectedApiKey,
    dismissInvalidApiKey: () => setRejectedApiKey(null),
    isResponseLoading: isResponseLoading || pendingTurn,
    setIsResponseLoading,
    isLoadingCitations,
    handleChat,
    handleNewChat,
    setMessages,
    cancel,
    detach,
    resetChat: () => {
      detach();
      chatIdRef.current = undefined;
      setChatId(undefined);
      setCurrentChatId(null);
      setRawMessages([]);
    },
    chatId,
  };
}
