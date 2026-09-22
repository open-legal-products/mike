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
  subscribeAssistantTurns,
  withLiveTurn,
  type AssistantTurnHandle,
  type LiveAssistantTurn,
} from "@/app/lib/assistantTurns";
import { assistantHistoryContent } from "@/app/lib/assistantHistoryContent";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import type { AssistantEvent, Message } from "@/app/components/shared/types";

interface UseAssistantChatOptions {
  initialMessages?: Message[];
  chatId?: string;
  projectId?: string;
  /** Adopts the server id as soon as it arrives, without navigation. */
  onChatCreated?: (chatId: string) => void;
}


export function useAssistantChat({
  initialMessages = [],
  chatId: initialChatId,
  projectId,
  onChatCreated,
}: UseAssistantChatOptions = {}) {
  const router = useRouter();
  const {
    replaceChatId,
    loadChats,
    setCurrentChatId,
    saveChat,
    setNewChatMessages,
    updateChatTitle,
  } = useChatHistoryContext();

  const [messages, setRawMessages] = useState<Message[]>(initialMessages);
  const [isResponseLoading, setIsResponseLoading] = useState(false);
  // An object, not a bare model id: an ask-inputs response submits without a
  // model, and a null id has to still open the popup — the id only decides
  // whether the provider can be named.
  const [rejectedApiKey, setRejectedApiKey] = useState<{
    model: string | null;
  } | null>(null);
  const [isLoadingCitations, setIsLoadingCitations] = useState(false);
  const [chatId, setChatId] = useState<string | undefined>(initialChatId);

  useEffect(() => {
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

  const handleChat = async (
    message: Message,
    opts?: {
      displayedDoc?: { filename: string; documentId: string } | null;
      askInputsResponse?: Extract<
        AssistantEvent,
        { type: "ask_inputs_response" }
      >;
    },
  ): Promise<string | null> => {
    if (!message.content.trim() || hasAssistantTurn(chatId)) return null;

    setIsResponseLoading(true);

    const lastMessage = messages[messages.length - 1];
    const isMessageAlreadyAdded =
      lastMessage &&
      lastMessage.role === "user" &&
      lastMessage.content === message.content;

    const apiMessagesForTurn: Message[] = isMessageAlreadyAdded
      ? messages
      : [...messages, message];
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
          const updated = messages.map((item) => ({
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
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const isCurrentRequest = () =>
      mountedRef.current && requestGenerationRef.current === generation;
    const cursor = createTurnCursor(chatId);
    // From here the turn record owns the assistant message; this hook, like
    // any hook that comes back to the thread, renders it by attaching.
    const turn = beginAssistantTurn(chatId, {
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
                chat_id: chatId,
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
                chat_id: chatId,
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
              streamed !== chatId && streamed !== streamedChatId;
            streamedChatId = streamed;
            if (!isCurrentRequest()) return;
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
          onErrorFrame: () => {
            if (isCurrentRequest()) setIsResponseLoading(false);
          },
        },
      });

      if (!isCurrentRequest()) return null;

      setIsResponseLoading(false);
      setIsLoadingCitations(false);

      const finalChatId = streamedChatId || chatId || null;
      if (finalChatId && finalChatId !== chatId) {
        if (chatId) {
          replaceChatId(
            chatId,
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
      if (isAbortError(error)) {
        sink.finalizeStreamingReasoning();
        sink.appendCancellation();
      } else {
        turn.update((assistantMessage) => ({
          ...assistantMessage,
          error: "Sorry, something went wrong.",
        }));
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
      setChatId(undefined);
      setCurrentChatId(null);
      setRawMessages([]);
    },
    chatId,
  };
}
