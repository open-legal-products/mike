"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { streamChat, streamProjectChat } from "@/app/lib/mikeApi";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import {
    AssistantEventBuffer,
    appendCancellationEvent,
    applyAssistantStreamFrame,
    cancelStreamingEvents,
    consumeAssistantSseStream,
} from "@/app/hooks/assistantStream";
import type { AssistantEvent, Message } from "@/app/components/shared/types";

interface UseAssistantChatOptions {
    initialMessages?: Message[];
    chatId?: string;
    projectId?: string;
}

export function useAssistantChat({
    initialMessages = [],
    chatId: initialChatId,
    projectId,
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

    const [messages, setMessages] = useState<Message[]>(initialMessages);
    const [isResponseLoading, setIsResponseLoading] = useState(false);
    const [isLoadingCitations, setIsLoadingCitations] = useState(false);
    const [chatId, setChatId] = useState<string | undefined>(initialChatId);

    const abortControllerRef = useRef<AbortController | null>(null);

    const updateLatestAssistantMessage = (
        updater: (message: Message) => Message,
    ) => {
        setMessages((prev) => {
            const assistantIndex = [...prev]
                .map((message, index) => ({ message, index }))
                .reverse()
                .find(({ message }) => message.role === "assistant")?.index;
            if (assistantIndex === undefined) return prev;
            const updated = [...prev];
            updated[assistantIndex] = updater(updated[assistantIndex]);
            return updated;
        });
    };

    // One buffer per hook instance. Its snapshots land on this chat's latest
    // assistant message; an agent's side-panel thread owns a different buffer
    // pointed at a different message, which is what lets the two stream at the
    // same time without writing over each other.
    const bufferRef = useRef<AssistantEventBuffer>(null);
    if (bufferRef.current === null) {
        bufferRef.current = new AssistantEventBuffer((events) =>
            updateLatestAssistantMessage((message) => ({ ...message, events })),
        );
    }
    const buffer = bufferRef.current;

    const cancel = () => {
        if (!abortControllerRef.current) return;
        abortControllerRef.current.abort();
        const snapshot = buffer.settle();
        updateLatestAssistantMessage((message) => ({
            ...message,
            events: cancelStreamingEvents(message.events ?? snapshot),
        }));
        setIsResponseLoading(false);
        setIsLoadingCitations(false);
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
        if (!message.content.trim()) return null;

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
                              ...(userInputThinkingEvent
                                  ? [userInputThinkingEvent]
                                  : []),
                          ],
                      };
                      return updated;
                  }
                  return updated;
              })()
            : apiMessagesForTurn;

        setMessages(
            optimisticResponseEvent
                ? displayMessages
                : [
                      ...displayMessages,
                      {
                          role: "assistant",
                          content: "",
                          citations: [],
                          events: [],
                      },
                  ],
        );

        let streamedChatId: string | null = null;

        buffer.reset(
            optimisticResponseEvent
                ? ([...displayMessages]
                      .reverse()
                      .find((item) => item.role === "assistant")?.events ?? [])
                : [],
        );

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            const apiMessages = apiMessagesForTurn.map((currentMessage) => ({
                role: currentMessage.role,
                content: currentMessage.content,
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

            const response = await (projectId
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
                  }));

            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw new Error(
                    `Chat request failed with status ${response.status}`,
                );
            }

            await consumeAssistantSseStream(response, (data) =>
                applyAssistantStreamFrame(data, buffer, {
                    onChatId: (id) => {
                        streamedChatId = id;
                        setChatId(id);
                        setCurrentChatId(id);
                    },
                    onChatTitle: (id, title) => updateChatTitle(id, title),
                    onContentDone: () => setIsLoadingCitations(true),
                    onError: (errorMessage) => {
                        updateLatestAssistantMessage((assistantMessage) => ({
                            ...assistantMessage,
                            events: buffer.snapshot(),
                            error: errorMessage,
                        }));
                        setIsResponseLoading(false);
                        setIsLoadingCitations(false);
                    },
                    onCitations: (citations, status) => {
                        updateLatestAssistantMessage((assistantMessage) => ({
                            ...assistantMessage,
                            citations,
                            citationStatus:
                                status === "final"
                                    ? citations.length
                                        ? "final"
                                        : undefined
                                    : status,
                        }));
                    },
                }),
            );

            buffer.finalizeReasoning();
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
                const chatBasePath = projectId
                    ? `/projects/${projectId}/assistant/chat`
                    : `/assistant/chat`;
                router.replace(`${chatBasePath}/${finalChatId}`);
            }

            await loadChats();

            return streamedChatId || null;
        } catch (error: unknown) {
            if (error instanceof Error && error.name === "AbortError") {
                buffer.finalizeContent();
                buffer.finalizeReasoning();
                buffer.reset(appendCancellationEvent(buffer.snapshot()));
                setMessages((prev) => {
                    const assistantIndex = [...prev]
                        .map((message, index) => ({ message, index }))
                        .reverse()
                        .find(({ message }) => message.role === "assistant")
                        ?.index;
                    if (assistantIndex !== undefined) {
                        const assistantMessage = prev[assistantIndex];
                        const events = appendCancellationEvent(
                            assistantMessage.events ?? buffer.snapshot(),
                        );
                        buffer.reset(events);
                        const updated = [...prev];
                        updated[assistantIndex] = {
                            ...assistantMessage,
                            events,
                        };
                        return updated;
                    }
                    buffer.reset([{ type: "content", text: "Cancelled by user." }]);
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            events: [
                                { type: "content", text: "Cancelled by user." },
                            ],
                        },
                    ];
                });
            } else {
                buffer.finalizeContent();
                const errorMessage = "Sorry, something went wrong.";
                setMessages((prev) => {
                    const assistantIndex = [...prev]
                        .map((message, index) => ({ message, index }))
                        .reverse()
                        .find(({ message }) => message.role === "assistant")
                        ?.index;
                    if (assistantIndex !== undefined) {
                        const updated = [...prev];
                        updated[assistantIndex] = {
                            ...updated[assistantIndex],
                            error: errorMessage,
                        };
                        return updated;
                    }
                    return [
                        ...prev,
                        {
                            role: "assistant",
                            content: "",
                            error: errorMessage,
                        },
                    ];
                });
            }

            setIsResponseLoading(false);
            setIsLoadingCitations(false);
            return null;
        } finally {
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

        setMessages([message]);
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
        isResponseLoading,
        setIsResponseLoading,
        isLoadingCitations,
        handleChat,
        handleNewChat,
        setMessages,
        cancel,
        chatId,
    };
}
