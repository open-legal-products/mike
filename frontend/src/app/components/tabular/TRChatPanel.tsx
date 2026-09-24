"use client";

import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pencil, Trash2 } from "lucide-react";
import { MikeIcon } from "@/app/components/chat/mike-icon";
import {
    streamTabularChat,
    getTabularChats,
    getTabularChatMessages,
    deleteTabularChat,
    renameTabularChat,
    tabularChatSelectionKey,
    mapTRMessages,
    type TRChat,
    type TRCitationAnnotation,
} from "@/app/lib/mikeApi";
import {
    isPanelDocument,
    type AssistantEvent,
    type Message,
} from "../shared/types";
import { ChatInput } from "../assistant/ChatInput";
import { PreResponseWrapper } from "../assistant/PreResponseWrapper";
import {
    DocReadBlock,
    EventBlock,
    ReasoningBlock,
} from "../assistant/message/EventBlocks";
import { readSseFrames } from "@/app/lib/sse";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";
import { UserVisibleError, notifyError, notifyInfo } from "@/app/lib/userFacingError";
import {
    LIQUID_GLASS_FLAT_CLASS,
} from "@/app/components/ui/liquid-surface";
import { ChatPanelHeader } from "../shared/ChatPanelHeader";
import { HeaderActionsMenu } from "../shared/HeaderActionsMenu";
import { cn } from "@/app/lib/utils";
import { buildTabularChatHistory } from "@/app/lib/tabularChatHistory";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { subscribeToTabularChatSettingsUpdates } from "@/app/lib/tabularChatSettingsEvents";
import { sortChatsByActivity, touchChatActivity } from "@/app/lib/chatActivity";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import {
    getModelProvider,
    providerLabel,
    type ModelProvider,
} from "@/app/lib/modelAvailability";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TRMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
    isStreaming?: boolean;
    /**
     * This turn ended in a failure. Already-streamed text is kept, but the
     * bubble has to say the answer is unfinished — a half-written answer with
     * nothing after it reads as a complete one.
     */
    error?: string;
}

function parseCourtlistenerEventCases(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    return value
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return null;
            }
            const row = item as Record<string, unknown>;
            return {
                cluster_id:
                    typeof row.cluster_id === "number" ? row.cluster_id : 0,
                case_name:
                    typeof row.case_name === "string" ? row.case_name : null,
                citation:
                    typeof row.citation === "string" ? row.citation : null,
                dateFiled:
                    typeof row.dateFiled === "string" ? row.dateFiled : null,
                url: typeof row.url === "string" ? row.url : null,
            };
        })
        .filter(
            (item): item is NonNullable<typeof item> =>
                !!item && item.cluster_id > 0,
        );
}

function parseCourtlistenerCaseSearches(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    return value
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return null;
            }
            const row = item as Record<string, unknown>;
            return {
                cluster_id:
                    typeof row.cluster_id === "number" ? row.cluster_id : null,
                query: typeof row.query === "string" ? row.query : "",
                total_matches:
                    typeof row.total_matches === "number"
                        ? row.total_matches
                        : 0,
                case_name:
                    typeof row.case_name === "string" ? row.case_name : null,
                citation:
                    typeof row.citation === "string" ? row.citation : null,
                error: typeof row.error === "string" ? row.error : undefined,
            };
        })
        .filter((item): item is NonNullable<typeof item> => !!item);
}

interface Props {
    reviewId: string;
    reviewTitle?: string | null;
    projectName?: string | null;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
    initialChatId?: string | null;
    onChatIdChange?: (chatId: string | null) => void;
    /**
     * Sending is member-tier server-side; false renders a read-only composer.
     *
     * `null` is the third answer — the review's role has not arrived yet. It
     * closes the composer like `false`, but ChatInput's placeholder stays
     * neutral instead of telling an owner they are "viewing only" for the
     * length of a fetch.
     */
    canSend?: boolean | null;
}

// ---------------------------------------------------------------------------
// Citation preprocessing (matches AssistantMessage.tsx pattern)
// ---------------------------------------------------------------------------

function preprocessTRCitations(
    text: string,
    annotations: TRCitationAnnotation[],
    citationsList: TRCitationAnnotation[],
): string {
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        const tokens = refs.flatMap((ref: number) => {
            const ann = annotations.find((a) => a.ref === ref);
            if (!ann) return [];
            const idx = citationsList.length;
            citationsList.push(ann);
            return [`\`§${idx}§\`\u200B`];
        });
        return tokens.length > 0 ? tokens.join("") : full;
    });
}

// ---------------------------------------------------------------------------
// ResponseStatus
// ---------------------------------------------------------------------------

function TRResponseStatus({ isActive }: { isActive: boolean }) {
    const [showDone, setShowDone] = useState(false);
    const [doneVisible, setDoneVisible] = useState(false);
    const wasActiveRef = useRef(false);

    useEffect(() => {
        if (wasActiveRef.current && !isActive) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- timed 'Done' flash on the active->idle transition
            setShowDone(true);
            setDoneVisible(true);
            const t = setTimeout(() => setDoneVisible(false), 1500);
            wasActiveRef.current = isActive;
            return () => clearTimeout(t);
        }
        if (!wasActiveRef.current && isActive) {
            setShowDone(false);
            setDoneVisible(false);
        }
        wasActiveRef.current = isActive;
    }, [isActive]);

    return (
        <div className="w-full h-9 flex items-center mb-2">
            <MikeIcon
                spin={isActive}
                done={showDone && doneVisible}
                mike={!(showDone && doneVisible)}
                size={22}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// TRAssistantMessage
// ---------------------------------------------------------------------------

type TREventGroup =
    | { kind: "pre"; events: AssistantEvent[]; indices: number[] }
    | {
          kind: "content";
          event: Extract<AssistantEvent, { type: "content" }>;
          index: number;
      };

function TRAssistantMessage({
    msg,
    onCitationClick,
}: {
    msg: TRMessage;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
}) {
    const annotations = msg.annotations ?? [];
    const citationsList: TRCitationAnnotation[] = [];

    // Pre-process all content events
    const processedTexts: string[] = (msg.events ?? []).map((e) =>
        e.type === "content"
            ? preprocessTRCitations(e.text, annotations, citationsList)
            : "",
    );

    const events = msg.events ?? [];

    // Group consecutive non-content events together so they share a single
    // PreResponseWrapper. Content events render between wrappers.
    const groups: TREventGroup[] = [];
    {
        let current: Extract<TREventGroup, { kind: "pre" }> | null = null;
        events.forEach((e, i) => {
            if (e.type === "content") {
                if (current) {
                    groups.push(current);
                    current = null;
                }
                groups.push({ kind: "content", event: e, index: i });
            } else {
                if (!current)
                    current = { kind: "pre", events: [], indices: [] };
                current.events.push(e);
                current.indices.push(i);
            }
        });
        if (current) groups.push(current);
    }

    const hasContentAfter = (groupIdx: number): boolean => {
        for (let i = groupIdx + 1; i < groups.length; i++) {
            const g = groups[i];
            if (g.kind === "content") return true;
        }
        return false;
    };

    const renderPreEvent = (
        event: AssistantEvent,
        index: number,
        allEvents: AssistantEvent[],
        key: number,
    ) => {
        const nextEvent = allEvents[index + 1];
        const showConnector =
            nextEvent !== undefined && nextEvent.type !== "content";

        if (event.type === "reasoning") {
            return (
                <ReasoningBlock
                    key={key}
                    text={event.text}
                    isStreaming={!!event.isStreaming && !!msg.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_read") {
            return (
                <DocReadBlock
                    key={key}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    showConnector={showConnector}
                    showFileIcon={false}
                />
            );
        }
        if (event.type === "thinking") {
            return (
                <EventBlock key={key} showConnector={showConnector} isStreaming>
                    <span>Thinking...</span>
                </EventBlock>
            );
        }
        return null;
    };

    const renderContent = (text: string, key: number) => (
        <div
            key={key}
            className="prose prose-sm max-w-none text-sm leading-relaxed"
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    p: ({ node, ...props }) => (
                        <p className="mb-2 leading-6" {...props} />
                    ),
                    ul: ({ node, ...props }) => (
                        <ul
                            className="list-disc list-outside mb-2 pl-4"
                            {...props}
                        />
                    ),
                    ol: ({ node, ...props }) => (
                        <ol
                            className="list-decimal list-outside mb-2 pl-4"
                            {...props}
                        />
                    ),
                    li: ({ node, ...props }) => (
                        <li className="mb-0.5 leading-6" {...props} />
                    ),
                    strong: ({ node, ...props }) => (
                        <strong className="font-semibold" {...props} />
                    ),
                    code: ({ children }) => {
                        const codeText = String(children);
                        const citMatch = codeText.match(/^§(\d+)§$/);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const cit = citationsList[idx];
                            if (cit) {
                                return (
                                    <CitationPillUI
                                        onClick={() =>
                                            onCitationClick(
                                                cit.col_index,
                                                cit.row_index,
                                            )
                                        }
                                        title={`${cit.col_name} · ${cit.doc_name.replace(/\.[^.]+$/, "")}`}
                                        className="mx-0.5 align-super"
                                    >
                                        {cit.ref}
                                    </CitationPillUI>
                                );
                            }
                        }
                        return (
                            <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono">
                                {children}
                            </code>
                        );
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );

    return (
        <div className="text-gray-900 font-serif">
            <TRResponseStatus isActive={!!msg.isStreaming} />
            {groups.length > 0 && (
                <div className="flex flex-col gap-2.5">
                    {groups.map((g, gIdx) => {
                        if (g.kind === "content") {
                            return renderContent(
                                processedTexts[g.index],
                                g.index,
                            );
                        }
                        const subsequentContent = hasContentAfter(gIdx);
                        // "Working" while at least one event in *this*
                        // wrapper is actively streaming. Gaps between real
                        // events are bridged by `pushThinkingPlaceholder`
                        // so this check stays continuously true through
                        // the whole pre-content phase.
                        const wrapperIsStreaming = g.events.some(
                            (event) =>
                                "isStreaming" in event && !!event.isStreaming,
                        );
                        return (
                            <PreResponseWrapper
                                key={`p-${g.indices[0]}`}
                                stepCount={g.events.length}
                                shouldMinimize={subsequentContent}
                                isStreaming={wrapperIsStreaming}
                            >
                                {g.events.map((event, i) =>
                                    renderPreEvent(
                                        event,
                                        i,
                                        g.events,
                                        g.indices[i],
                                    ),
                                )}
                            </PreResponseWrapper>
                        );
                    })}
                </div>
            )}
            {msg.error ? (
                <p className="mt-2 text-xs text-red-600">{msg.error}</p>
            ) : null}
        </div>
    );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({
    msg,
    onCitationClick,
}: {
    msg: TRMessage;
    onCitationClick: (colIdx: number, rowIdx: number) => void;
}) {
    if (msg.role === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[90%] rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-800 whitespace-pre-wrap">
                    {msg.content}
                </div>
            </div>
        );
    }
    return <TRAssistantMessage msg={msg} onCitationClick={onCitationClick} />;
}

// ---------------------------------------------------------------------------
// Drip helpers
// ---------------------------------------------------------------------------

function findLastContentIndex(events: AssistantEvent[]): number {
    for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === "content") return i;
    }
    return -1;
}

const MESSAGE_TOP_INSET = 80;
const MESSAGE_GAP = 16;
const COMPOSER_GAP = 16;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TRChatPanel({
    reviewId,
    reviewTitle,
    projectName,
    onCitationClick,
    initialChatId,
    onChatIdChange,
    canSend = true,
}: Props) {
    const [chats, setChats] = useState<TRChat[]>([]);
    const [currentChatId, setCurrentChatId] = useState<string | null>(
        initialChatId ?? null,
    );
    const currentChatIdRef = useRef(currentChatId);
    useLayoutEffect(() => {
        currentChatIdRef.current = currentChatId;
    }, [currentChatId]);
    const [chatResponseStatuses, setChatResponseStatuses] = useState<
        Record<string, "loading" | "complete">
    >({});
    const [currentChatTitle, setCurrentChatTitle] = useState<string | null>(
        null,
    );
    const [currentChatModel, setCurrentChatModel] = useState<
        string | null | undefined
    >(initialChatId ? undefined : null);
    const [currentChatReasoningLevel, setCurrentChatReasoningLevel] = useState<
        NonNullable<Message["reasoning"]> | null | undefined
    >(initialChatId ? undefined : null);
    const [messages, setMessages] = useState<TRMessage[]>([]);
    const [titleDraft, setTitleDraft] = useState<string | null>(null);
    const [isLoadingChats, setIsLoadingChats] = useState(true);
    const [isLoading, setIsLoading] = useState(false);
    const [isLoadingMessages, setIsLoadingMessages] = useState(false);
    const [rejectedApiKey, setRejectedApiKey] = useState<{
        provider: ModelProvider | null;
    } | null>(null);
    const [minHeight, setMinHeight] = useState("0px");
    const [messagesVisible, setMessagesVisible] = useState(false);
    const [panelWidth, setPanelWidth] = useState(380);
    const [isResizing, setIsResizing] = useState(false);
    const [inputHeight, setInputHeight] = useState(96);

    const resizeStartRef = useRef({ x: 0, width: 380 });
    const composerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isResizing) return;
        const MIN_WIDTH = 280;
        const MAX_WIDTH = 800;
        function onMove(e: MouseEvent) {
            const delta = resizeStartRef.current.x - e.clientX;
            setPanelWidth(
                Math.min(
                    MAX_WIDTH,
                    Math.max(MIN_WIDTH, resizeStartRef.current.width + delta),
                ),
            );
        }
        function onUp() {
            setIsResizing(false);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
    }, [isResizing]);

    useEffect(() => {
        const composer = composerRef.current;
        if (!composer) return;
        const updateHeight = () => {
            setInputHeight(composer.getBoundingClientRect().height);
        };
        updateHeight();
        const observer = new ResizeObserver(updateHeight);
        observer.observe(composer);
        window.addEventListener("resize", updateHeight);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updateHeight);
        };
    }, []);

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<AbortController | null>(null);
    // Bumped whenever the message list stops belonging to the running stream
    // (new chat, loaded chat, new submit, unmount). The stream loop checks it
    // before writing, so an orphaned stream can't repaint someone else's chat.
    const streamGenerationRef = useRef(0);
    const hasScrolledRef = useRef(false);
    const scrollLatestUserToTop = useCallback((behavior: ScrollBehavior) => {
        const container = messagesContainerRef.current;
        const message = latestUserMessageRef.current;
        if (!container || !message) return;
        const messageTop =
            message.getBoundingClientRect().top -
            container.getBoundingClientRect().top +
            container.scrollTop;
        container.scrollTo({
            top: Math.max(0, messageTop - MESSAGE_TOP_INSET),
            behavior,
        });
    }, []);

    // Drip animation refs
    const dripIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const dripTargetRef = useRef<string>("");
    const dripDisplayLenRef = useRef<number>(0);
    const eventsRef = useRef<AssistantEvent[]>([]);
    const DRIP_CHARS = 8;

    // Load existing chats from DB on mount
    useEffect(() => {
        const loadChats = () => {
            setIsLoadingChats(true);
            getTabularChats(reviewId)
                .then((loadedChats) => {
                    setChats(sortChatsByActivity(loadedChats));
                    if (!initialChatId) return;
                    const initialChat = loadedChats.find(
                        (chat) => chat.id === initialChatId,
                    );
                    setCurrentChatModel(initialChat?.model ?? null);
                    setCurrentChatReasoningLevel(
                        initialChat?.reasoning_level ?? null,
                    );
                })
                .catch((error) => {
                    if (initialChatId) {
                        setCurrentChatModel(null);
                        setCurrentChatReasoningLevel(null);
                    }
                    // Without this the chat menu just stays empty and the
                    // model/reasoning pickers silently fall back to defaults.
                    notifyError(error, {
                        action: "load your chat history",
                        dedupeKey: `tr-chats:${reviewId}`,
                        onRetry: loadChats,
                    });
                })
                .finally(() => setIsLoadingChats(false));
        };
        loadChats();
    }, [reviewId]); // eslint-disable-line react-hooks/exhaustive-deps -- initialChatId is the mount-time thread; live chat id changes must not refetch settings

    // ChatInput persists through UserProfileContext. Mirror successful saves
    // into this panel's chat cache so navigating away and back does not restore
    // the stale model/reasoning values fetched when the panel first mounted.
    useEffect(
        () =>
            subscribeToTabularChatSettingsUpdates((update) => {
                if (update.reviewId !== reviewId) return;
                setChats((current) =>
                    touchChatActivity(
                        current.map((chat) =>
                            chat.id === update.chatId
                                ? {
                                      ...chat,
                                      ...(update.model !== undefined
                                          ? { model: update.model }
                                          : {}),
                                      ...(update.reasoningLevel !== undefined
                                          ? {
                                                reasoning_level:
                                                    update.reasoningLevel,
                                            }
                                          : {}),
                                  }
                                : chat,
                        ),
                        update.chatId,
                    ),
                );
                if (update.chatId !== currentChatId) return;
                if (update.model !== undefined) {
                    setCurrentChatModel(update.model);
                }
                if (update.reasoningLevel !== undefined) {
                    setCurrentChatReasoningLevel(update.reasoningLevel);
                }
            }),
        [currentChatId, reviewId],
    );

    // Load messages for an initial chat id (e.g. from URL)
    useEffect(() => {
        if (!initialChatId) return;
        setIsLoadingMessages(true);
        const loadInitialMessages = () => {
            setIsLoadingMessages(true);
            getTabularChatMessages(reviewId, initialChatId)
                .then((raw) => setMessages(mapTRMessages(raw) as TRMessage[]))
                .catch((error) => {
                    // An empty transcript is indistinguishable from a new
                    // chat, so say the history could not be loaded.
                    notifyError(error, {
                        action: "load this chat",
                        dedupeKey: `tr-chat-messages:${initialChatId}`,
                        onRetry: loadInitialMessages,
                    });
                })
                .finally(() => setIsLoadingMessages(false));
        };
        loadInitialMessages();
    }, [reviewId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fill in title once chats list arrives
    useEffect(() => {
        if (currentChatId && !currentChatTitle) {
            const chat = chats.find((c) => c.id === currentChatId);
            if (chat) setCurrentChatTitle(chat.title ?? null);
        }
    }, [chats, currentChatId, currentChatTitle]);

    // Emit currentChatId changes to parent
    const onChatIdChangeRef = useRef(onChatIdChange);
    useEffect(() => {
        onChatIdChangeRef.current = onChatIdChange;
    });
    useEffect(() => {
        onChatIdChangeRef.current?.(currentChatId);
    }, [currentChatId]);

    useEffect(() => {
        hasScrolledRef.current = false;
    }, [currentChatId]);

    useEffect(() => {
        if (isLoadingMessages) {
            hasScrolledRef.current = false;
            setMessagesVisible(false);
            return;
        }
        if (messages.length === 0) {
            hasScrolledRef.current = false;
            setMessagesVisible(false);
        } else if (!hasScrolledRef.current) {
            const userMsgCount = messages.filter(
                (m) => m.role === "user",
            ).length;
            if (
                userMsgCount >= 2 &&
                latestUserMessageRef.current &&
                messagesContainerRef.current
            ) {
                const timer = setTimeout(() => {
                    scrollLatestUserToTop("auto");
                    hasScrolledRef.current = true;
                    setMessagesVisible(true);
                }, 100);
                return () => clearTimeout(timer);
            } else {
                hasScrolledRef.current = true;
                setMessagesVisible(true);
            }
        }
    }, [messages, isLoadingMessages, currentChatId, scrollLatestUserToTop]);

    useLayoutEffect(() => {
        if (isLoadingMessages) return;
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        const composerSpace = Math.ceil(inputHeight + COMPOSER_GAP);
        setMinHeight(
            `${Math.max(
                0,
                containerEl.clientHeight -
                    MESSAGE_TOP_INSET -
                    userEl.offsetHeight -
                    MESSAGE_GAP -
                    composerSpace,
            )}px`,
        );
    }, [inputHeight, messages.length, isLoadingMessages, currentChatId]);

    useEffect(() => {
        setTitleDraft(null);
    }, [currentChatId]);

    // ---- drip ----

    function stopDrip() {
        if (dripIntervalRef.current !== null) {
            clearInterval(dripIntervalRef.current);
            dripIntervalRef.current = null;
        }
    }

    // Detach whatever is still streaming from the message list: stop the
    // 16ms drip timer and retire the generation so the in-flight loop stops
    // writing into a list it no longer owns. Deliberately does NOT abort —
    // the backend reads a closed socket as a cancellation and persists a
    // truncated "Cancelled by user." answer, so closing the panel or
    // switching chats must let the request run to completion. Only
    // handleCancel (the Stop control) aborts.
    function detachActiveStream() {
        streamGenerationRef.current += 1;
        stopDrip();
    }

    // This panel is conditionally mounted, so without a cleanup the drip
    // interval survives it.
    useEffect(() => detachActiveStream, []); // eslint-disable-line react-hooks/exhaustive-deps

    function updateLastContentEvent(
        prev: TRMessage[],
        text: string,
        isStreaming?: boolean,
    ): TRMessage[] {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role !== "assistant") return prev;
        const evts = last.events ?? [];
        const idx = findLastContentIndex(evts);
        if (idx < 0) return prev;
        const newEvents = [...evts];
        newEvents[idx] = isStreaming
            ? { type: "content", text, isStreaming: true }
            : { type: "content", text };
        updated[updated.length - 1] = { ...last, events: newEvents };
        return updated;
    }

    // Mirror the dripped content text onto eventsRef.current so that any
    // subsequent setMessages built from a refsnapshot (pushEvent,
    // updateMatchingEvent, reasoning_*, etc.) doesn't wipe out the content
    // by replacing it with the stale empty placeholder.
    function syncDripIntoEventsRef(text: string, isStreaming: boolean) {
        const evts = eventsRef.current;
        const idx = findLastContentIndex(evts);
        if (idx < 0) return;
        const newEvents = [...evts];
        newEvents[idx] = isStreaming
            ? { type: "content", text, isStreaming: true }
            : { type: "content", text };
        eventsRef.current = newEvents;
    }

    function flushDrip() {
        stopDrip();
        const target = dripTargetRef.current;
        dripDisplayLenRef.current = target.length;
        syncDripIntoEventsRef(target, false);
        setMessages((prev) => updateLastContentEvent(prev, target));
    }

    function startDrip() {
        if (dripIntervalRef.current !== null) return;
        dripIntervalRef.current = setInterval(() => {
            const target = dripTargetRef.current;
            const displayLen = dripDisplayLenRef.current;
            if (displayLen >= target.length) return;
            const newLen = Math.min(displayLen + DRIP_CHARS, target.length);
            dripDisplayLenRef.current = newLen;
            const slice = target.slice(0, newLen);
            syncDripIntoEventsRef(slice, true);
            setMessages((prev) => updateLastContentEvent(prev, slice, true));
        }, 16);
    }

    // ---- event helpers ----

    // Transient placeholder events that bridge the gap between real SSE
    // events so the PreResponseWrapper doesn't briefly flip to "Completed"
    // when one block ends before the next starts. Anytime a real event
    // arrives (or content begins streaming), drop them first.
    function isStreamingPlaceholder(e: AssistantEvent) {
        return e.type === "thinking" && !!e.isStreaming;
    }

    function clearStreamingPlaceholders() {
        const before = eventsRef.current;
        const after = before.filter((e) => !isStreamingPlaceholder(e));
        if (after.length === before.length) return;
        eventsRef.current = after;
        const snapshot = [...after];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    }

    function pushThinkingPlaceholder() {
        const events = eventsRef.current;
        const last = events[events.length - 1];
        // Don't stack placeholders back-to-back.
        if (last && isStreamingPlaceholder(last)) return;
        eventsRef.current = [
            ...events,
            { type: "thinking" as const, isStreaming: true },
        ];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    }

    function pushEvent(event: AssistantEvent) {
        // Drop any in-flight placeholder unless we're pushing one ourselves.
        let next = eventsRef.current;
        if (event.type !== "thinking") {
            next = next.filter((e) => !isStreamingPlaceholder(e));
        }
        eventsRef.current = [...next, event];
        const snapshot = [...eventsRef.current];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
    }

    function updateMatchingEvent(
        predicate: (e: AssistantEvent) => boolean,
        updater: (e: AssistantEvent) => AssistantEvent,
    ) {
        const events = eventsRef.current;
        const idx = [...events]
            .map((_, i) => i)
            .reverse()
            .find((i) => predicate(events[i]));
        if (idx === undefined) return false;
        const newEvents = [...events];
        newEvents[idx] = updater(events[idx]);
        eventsRef.current = newEvents;
        const snapshot = [...newEvents];
        setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
                updated[updated.length - 1] = { ...last, events: snapshot };
            }
            return updated;
        });
        return true;
    }

    // ---- chat actions ----

    function handleNewChat() {
        detachActiveStream();
        setIsLoading(false);
        currentChatIdRef.current = null;
        setCurrentChatId(null);
        setCurrentChatTitle(null);
        setCurrentChatModel(null);
        setCurrentChatReasoningLevel(null);
        setMessages([]);
    }

    async function handleDeleteChat(chatId: string) {
        // Everything the optimistic removal throws away, so a failed delete
        // can put the thread back instead of losing it from the menu.
        const snapshot = {
            chats,
            currentChatId,
            currentChatTitle,
            currentChatModel,
            currentChatReasoningLevel,
            messages,
        };
        setChats((prev) => prev.filter((c) => c.id !== chatId));
        const clearedActiveThread = chatId === currentChatId;
        if (clearedActiveThread) {
            // Same exit as New chat / Load chat: retire the in-flight stream's
            // generation so its late events cannot land in the emptied list.
            detachActiveStream();
            setIsLoading(false);
            currentChatIdRef.current = null;
            setCurrentChatId(null);
            setCurrentChatTitle(null);
            setCurrentChatModel(null);
            setCurrentChatReasoningLevel(null);
            setMessages([]);
        }
        // Every thread switch (and every submit) bumps this, so it doubles
        // as "has the panel moved on since we emptied it?".
        const clearedGeneration = streamGenerationRef.current;
        try {
            await deleteTabularChat(reviewId, chatId);
        } catch (error) {
            // Put back only the thread that failed to delete: the list is
            // reloaded, renamed and appended to while this request is in
            // flight, and restoring the whole snapshot threw that away.
            setChats((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot.chats, [
                    chatId,
                ]),
            );
            if (
                clearedActiveThread &&
                // Reopen the deleted thread only if the user has not since
                // opened another, started a new chat or sent a message —
                // re-seating these messages over that would lose their work.
                streamGenerationRef.current === clearedGeneration
            ) {
                setCurrentChatId(snapshot.currentChatId);
                setCurrentChatTitle(snapshot.currentChatTitle);
                setCurrentChatModel(snapshot.currentChatModel);
                setCurrentChatReasoningLevel(
                    snapshot.currentChatReasoningLevel,
                );
                setMessages(snapshot.messages);
            }
            notifyError(error, {
                action: "delete this chat",
                onRetry: () => {
                    void handleDeleteChat(chatId);
                },
            });
        }
    }

    async function handleRenameChat(chatId: string, title: string) {
        const previousTitle =
            chats.find((c) => c.id === chatId)?.title ?? null;
        setChats((prev) =>
            touchChatActivity(
                prev.map((c) => (c.id === chatId ? { ...c, title } : c)),
                chatId,
            ),
        );
        if (chatId === currentChatId) setCurrentChatTitle(title);
        try {
            await renameTabularChat(reviewId, chatId, title);
        } catch (error) {
            setChats((prev) =>
                prev.map((c) =>
                    c.id === chatId ? { ...c, title: previousTitle } : c,
                ),
            );
            if (chatId === currentChatId) setCurrentChatTitle(previousTitle);
            notifyError(error, {
                action: "rename this chat",
                onRetry: () => {
                    void handleRenameChat(chatId, title);
                },
            });
        }
    }

    async function handleLoadChat(chatId: string) {
        detachActiveStream();
        setIsLoading(false);
        currentChatIdRef.current = chatId;
        setChatResponseStatuses((current) => {
            if (current[chatId] !== "complete") return current;
            const next = { ...current };
            delete next[chatId];
            return next;
        });
        const chat = chats.find((c) => c.id === chatId);
        setCurrentChatId(chatId);
        setCurrentChatTitle(chat?.title ?? null);
        setCurrentChatModel(chat?.model ?? null);
        setCurrentChatReasoningLevel(chat?.reasoning_level ?? null);
        setMessages([]);
        setIsLoadingMessages(true);
        try {
            const raw = await getTabularChatMessages(reviewId, chatId);
            setMessages(mapTRMessages(raw) as TRMessage[]);
        } catch (error) {
            // Otherwise the thread opens blank and reads as an empty chat.
            notifyError(error, {
                action: "load this chat",
                dedupeKey: `tr-chat-messages:${chatId}`,
                onRetry: () => {
                    void handleLoadChat(chatId);
                },
            });
        } finally {
            setIsLoadingMessages(false);
        }
    }

    function handleCancel() {
        abortRef.current?.abort();
    }

    async function handleSubmit(
        message: Message,
        retry?: { transcript: TRMessage[]; chatId: string | null },
    ) {
        const trimmed = message.content.trim();
        if (!trimmed || isLoading) return;
        if (!message.model || !message.reasoning) return;
        setCurrentChatModel(message.model);
        setCurrentChatReasoningLevel(message.reasoning);

        // Build messages array for backend (plain text history)
        const transcriptBeforeSend = retry?.transcript ?? messages;
        const targetChatId = retry ? retry.chatId : currentChatId;
        const history = buildTabularChatHistory(transcriptBeforeSend);
        const allMessages = [...history, { role: "user", content: trimmed }];

        // The transcript as it stood before this turn. Retry rewinds to it so
        // resending cannot duplicate the question or the failed answer.
        const userMsg: TRMessage = { role: "user", content: trimmed };
        const assistantMsg: TRMessage = {
            role: "assistant",
            content: "",
            events: [],
            isStreaming: true,
        };

        setMessages([...transcriptBeforeSend, userMsg, assistantMsg]);
        setIsLoading(true);

        setTimeout(() => {
            scrollLatestUserToTop("smooth");
        }, 50);

        detachActiveStream();
        const gen = streamGenerationRef.current;
        dripTargetRef.current = "";
        dripDisplayLenRef.current = 0;
        eventsRef.current = [];

        const controller = new AbortController();
        abortRef.current = controller;
        let streamChatId = targetChatId;
        const retryThisTurn = async () => {
            if (streamGenerationRef.current !== gen || abortRef.current ||
                currentChatIdRef.current !== streamChatId) {
                notifyInfo("This chat has changed. Send the message again from the chat it belongs to.");
                return;
            }
            await handleSubmit(message, { transcript: transcriptBeforeSend, chatId: streamChatId });
        };
        let streamHadError = false;
        if (streamChatId) {
            setChatResponseStatuses((current) => ({
                ...current,
                [streamChatId!]: "loading",
            }));
            setChats((current) => touchChatActivity(current, streamChatId!));
        }

        try {
            const response = await streamTabularChat(
                reviewId,
                allMessages,
                targetChatId,
                controller.signal,
                { reviewTitle, projectName },
                message.model,
                message.reasoning,
            );
            for await (const frame of readSseFrames(response, {
                signal: controller.signal,
            })) {
                const data = frame as Record<string, unknown>;

                if (data.type === "chat_id") {
                    const newId = data.chatId as string;
                    streamChatId = newId;
                    setChatResponseStatuses((current) => ({
                        ...current,
                        [newId]: "loading",
                    }));
                    setChats((prev) => {
                        const now = new Date().toISOString();
                        const next = prev.some((chat) => chat.id === newId)
                            ? prev
                            : [
                                  {
                                      id: newId,
                                      title: null,
                                      model: message.model ?? null,
                                      reasoning_level:
                                          message.reasoning ?? null,
                                      created_at: now,
                                      updated_at: now,
                                  },
                                  ...prev,
                              ];
                        return touchChatActivity(next, newId, now);
                    });
                    if (streamGenerationRef.current !== gen) continue;
                    currentChatIdRef.current = newId;
                    setCurrentChatId(newId);
                    continue;
                }
                if (data.type === "error") streamHadError = true;

                // Another chat owns the message list now — stop writing,
                // but keep draining: breaking out cancels the reader, which
                // closes the socket and makes the server persist a
                // truncated answer.
                if (streamGenerationRef.current !== gen) continue;

                try {
                        if (data.type === "chat_title") {
                            const { chatId, title } = data as {
                                chatId: string;
                                title: string;
                            };
                            setChats((prev) =>
                                touchChatActivity(
                                    prev.map((c) =>
                                        c.id === chatId ? { ...c, title } : c,
                                    ),
                                    chatId,
                                ),
                            );
                            setCurrentChatTitle(title);
                            continue;
                        }

                        if (data.type === "error") {
                            if (data.code === "invalid_api_key") {
                                setRejectedApiKey({
                                    provider: getModelProvider(message.model),
                                });
                            }
                            clearStreamingPlaceholders();
                            pushEvent({
                                type: "error",
                                message:
                                    data.safe_to_display === true &&
                                    typeof data.message === "string" &&
                                    data.message.trim()
                                        ? data.message.trim()
                                        : "An error occurred. Please try again.",
                                ...(data.safe_to_display === true
                                    ? { safe_to_display: true }
                                    : {}),
                                ...(data.code === "invalid_api_key"
                                    ? { code: "invalid_api_key" as const }
                                    : {}),
                            });
                            // The server ends a failed turn with this frame
                            // and then `[DONE]`, so without this branch the
                            // answer just stops mid-sentence and looks
                            // finished. `safe_to_display` marks text the
                            // backend wrote for the user (a configuration
                            // refusal); anything else is internal and is
                            // replaced.
                            const safeToDisplay = data.safe_to_display === true;
                            const errorText =
                                safeToDisplay &&
                                typeof data.message === "string" &&
                                data.message.trim()
                                    ? data.message.trim()
                                    : "Mike couldn't finish this answer. Try again.";
                            flushDrip();
                            clearStreamingPlaceholders();
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    // Partial content stays; the turn is
                                    // marked failed rather than erased.
                                    updated[updated.length - 1] = {
                                        ...last,
                                        isStreaming: false,
                                        error: errorText,
                                    };
                                }
                                return updated;
                            });
                            notifyError(
                                new UserVisibleError(errorText, {
                                    kind: "server",
                                    // A refusal the backend wrote (no key, a
                                    // disallowed model) answers the same way
                                    // however many times it is re-sent.
                                    retryable: !safeToDisplay,
                                }),
                                {
                                    action: "get a response",
                                    dedupeKey: `tr-chat-error:${currentChatId ?? reviewId}`,
                                    onRetry: safeToDisplay
                                        ? undefined
                                        : retryThisTurn,
                                },
                            );
                            setIsLoading(false);
                            continue;
                        }

                        if (data.type === "reasoning_delta") {
                            const text = data.text as string;
                            const events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text + text,
                                        isStreaming: true,
                                    },
                                ];
                            } else {
                                // New reasoning block — drop any bridging
                                // placeholder before it so the wrapper
                                // doesn't render both.
                                const cleaned = events.filter(
                                    (e) => !isStreamingPlaceholder(e),
                                );
                                eventsRef.current = [
                                    ...cleaned,
                                    {
                                        type: "reasoning" as const,
                                        text,
                                        isStreaming: true,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }

                        if (data.type === "reasoning_block_end") {
                            const events = eventsRef.current;
                            const last = events[events.length - 1];
                            if (
                                last?.type === "reasoning" &&
                                last.isStreaming
                            ) {
                                eventsRef.current = [
                                    ...events.slice(0, -1),
                                    {
                                        type: "reasoning" as const,
                                        text: last.text,
                                    },
                                ];
                            }
                            const snapshot = [...eventsRef.current];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        events: snapshot,
                                    };
                                }
                                return updated;
                            });
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "content_delta") {
                            const text = data.text as string;
                            dripTargetRef.current += text;
                            const events = eventsRef.current;
                            const lastEvent = events[events.length - 1];
                            if (
                                lastEvent?.type !== "content" ||
                                !lastEvent.isStreaming
                            ) {
                                // Finalize any still-streaming reasoning
                                // event AND drop bridging placeholders so
                                // the wrapper transitions cleanly into
                                // content.
                                const finalized = events
                                    .filter((e) => !isStreamingPlaceholder(e))
                                    .map((e) =>
                                        e.type === "reasoning" && e.isStreaming
                                            ? {
                                                  type: "reasoning" as const,
                                                  text: e.text,
                                              }
                                            : e,
                                    );
                                eventsRef.current = [
                                    ...finalized,
                                    {
                                        type: "content" as const,
                                        text: "",
                                        isStreaming: true,
                                    },
                                ];
                                const snapshot = [...eventsRef.current];
                                setMessages((prev) => {
                                    const updated = [...prev];
                                    const last = updated[updated.length - 1];
                                    if (last?.role === "assistant") {
                                        updated[updated.length - 1] = {
                                            ...last,
                                            events: snapshot,
                                        };
                                    }
                                    return updated;
                                });
                            }
                            startDrip();
                            continue;
                        }

                        if (
                            data.type === "courtlistener_search_case_law_start"
                        ) {
                            pushEvent({
                                type: "courtlistener_search_case_law",
                                query: (data.query as string) ?? "",
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "courtlistener_search_case_law") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type ===
                                        "courtlistener_search_case_law" &&
                                    e.query === (data.query as string) &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "courtlistener_search_case_law",
                                    query: (data.query as string) ?? "",
                                    result_count:
                                        typeof data.result_count === "number"
                                            ? (data.result_count as number)
                                            : 0,
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "courtlistener_get_cases_start") {
                            pushEvent({
                                type: "courtlistener_get_cases",
                                cluster_ids: Array.isArray(data.cluster_ids)
                                    ? (data.cluster_ids as unknown[]).filter(
                                          (value: unknown): value is number =>
                                              typeof value === "number",
                                      )
                                    : [],
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "courtlistener_get_cases") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "courtlistener_get_cases" &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "courtlistener_get_cases",
                                    cluster_ids: Array.isArray(data.cluster_ids)
                                        ? (
                                              data.cluster_ids as unknown[]
                                          ).filter(
                                              (
                                                  value: unknown,
                                              ): value is number =>
                                                  typeof value === "number",
                                          )
                                        : [],
                                    case_count:
                                        typeof data.case_count === "number"
                                            ? (data.case_count as number)
                                            : 0,
                                    opinion_count:
                                        typeof data.opinion_count === "number"
                                            ? (data.opinion_count as number)
                                            : 0,
                                    cases: parseCourtlistenerEventCases(
                                        data.cases,
                                    ),
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "courtlistener_find_in_case_start") {
                            const searches = parseCourtlistenerCaseSearches(
                                data.searches,
                            );
                            pushEvent({
                                type: "courtlistener_find_in_case",
                                cluster_id: searches?.length
                                    ? null
                                    : typeof data.cluster_id === "number"
                                      ? (data.cluster_id as number)
                                      : null,
                                query: searches?.length
                                    ? ""
                                    : ((data.query as string) ?? ""),
                                searches,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "courtlistener_find_in_case") {
                            const searches = parseCourtlistenerCaseSearches(
                                data.searches,
                            );
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "courtlistener_find_in_case" &&
                                    (searches?.length
                                        ? Array.isArray(e.searches)
                                        : e.cluster_id ===
                                              (typeof data.cluster_id ===
                                              "number"
                                                  ? (data.cluster_id as number)
                                                  : null) &&
                                          e.query === (data.query as string)) &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "courtlistener_find_in_case",
                                    cluster_id: searches?.length
                                        ? null
                                        : typeof data.cluster_id === "number"
                                          ? (data.cluster_id as number)
                                          : null,
                                    query: searches?.length
                                        ? ""
                                        : ((data.query as string) ?? ""),
                                    total_matches:
                                        typeof data.total_matches === "number"
                                            ? (data.total_matches as number)
                                            : 0,
                                    searches,
                                    case_name:
                                        typeof data.case_name === "string"
                                            ? (data.case_name as string)
                                            : null,
                                    citation:
                                        typeof data.citation === "string"
                                            ? (data.citation as string)
                                            : null,
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "courtlistener_read_case_start") {
                            pushEvent({
                                type: "courtlistener_read_case",
                                cluster_id:
                                    typeof data.cluster_id === "number"
                                        ? (data.cluster_id as number)
                                        : null,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "courtlistener_read_case") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "courtlistener_read_case" &&
                                    e.cluster_id ===
                                        (typeof data.cluster_id === "number"
                                            ? (data.cluster_id as number)
                                            : null) &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "courtlistener_read_case",
                                    cluster_id:
                                        typeof data.cluster_id === "number"
                                            ? (data.cluster_id as number)
                                            : null,
                                    case_name:
                                        typeof data.case_name === "string"
                                            ? (data.case_name as string)
                                            : null,
                                    citation:
                                        typeof data.citation === "string"
                                            ? (data.citation as string)
                                            : null,
                                    opinion_count:
                                        typeof data.opinion_count === "number"
                                            ? (data.opinion_count as number)
                                            : 0,
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (
                            data.type === "courtlistener_verify_citations_start"
                        ) {
                            pushEvent({
                                type: "courtlistener_verify_citations",
                                citation_count:
                                    typeof data.citation_count === "number"
                                        ? (data.citation_count as number)
                                        : 0,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "courtlistener_verify_citations") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type ===
                                        "courtlistener_verify_citations" &&
                                    !!e.isStreaming,
                                () => ({
                                    type: "courtlistener_verify_citations",
                                    citation_count:
                                        typeof data.citation_count === "number"
                                            ? (data.citation_count as number)
                                            : 0,
                                    match_count:
                                        typeof data.match_count === "number"
                                            ? (data.match_count as number)
                                            : 0,
                                    error:
                                        typeof data.error === "string"
                                            ? (data.error as string)
                                            : undefined,
                                    isStreaming: false,
                                }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "case_citation") {
                            pushEvent({
                                type: "case_citation",
                                cluster_id:
                                    typeof data.cluster_id === "number"
                                        ? (data.cluster_id as number)
                                        : null,
                                case_name:
                                    typeof data.case_name === "string"
                                        ? (data.case_name as string)
                                        : null,
                                citation:
                                    typeof data.citation === "string"
                                        ? (data.citation as string)
                                        : null,
                                url: data.url as string,
                            });
                            continue;
                        }

                        if (data.type === "case_opinions") {
                            pushEvent({
                                type: "case_opinions",
                                cluster_id:
                                    typeof data.cluster_id === "number"
                                        ? (data.cluster_id as number)
                                        : 0,
                                document: isPanelDocument(data.document)
                                    ? data.document
                                    : undefined,
                            });
                            continue;
                        }

                        if (data.type === "doc_read_start") {
                            pushEvent({
                                type: "doc_read",
                                filename: data.filename as string,
                                isStreaming: true,
                            });
                            continue;
                        }

                        if (data.type === "doc_read") {
                            updateMatchingEvent(
                                (e) =>
                                    e.type === "doc_read" &&
                                    e.filename === data.filename &&
                                    !!e.isStreaming,
                                (e) => ({ ...e, isStreaming: false }),
                            );
                            pushThinkingPlaceholder();
                            continue;
                        }

                        if (data.type === "citations") {
                            // End-of-stream signal — scrub any lingering
                            // placeholders so they don't persist into the
                            // finalised message.
                            clearStreamingPlaceholders();
                            const incoming = (data.citations ??
                                []) as TRCitationAnnotation[];
                            setMessages((prev) => {
                                const updated = [...prev];
                                const last = updated[updated.length - 1];
                                if (last?.role === "assistant") {
                                    updated[updated.length - 1] = {
                                        ...last,
                                        annotations: incoming,
                                    };
                                }
                                return updated;
                            });
                            continue;
                        }
                } catch (err) {
                    // One notice per stream: an event we could not apply means
                    // part of the answer is missing from the transcript, and
                    // the stream itself keeps going.
                    notifyError(err, {
                        action: "show part of this answer",
                        dedupeKey: `tr-chat-frame:${gen}`,
                    });
                }
            }

            if (streamChatId) {
                setChats((current) =>
                    touchChatActivity(current, streamChatId!),
                );
                setChatResponseStatuses((current) => {
                    if (
                        streamHadError ||
                        currentChatIdRef.current === streamChatId
                    ) {
                        if (!(streamChatId! in current)) return current;
                        const next = { ...current };
                        delete next[streamChatId!];
                        return next;
                    }
                    return { ...current, [streamChatId!]: "complete" };
                });
            }

            if (streamGenerationRef.current !== gen) return;

            flushDrip();
            clearStreamingPlaceholders();
            setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                    updated[updated.length - 1] = {
                        ...last,
                        isStreaming: false,
                    };
                }
                return updated;
            });
        } catch (err: unknown) {
            if (streamChatId) {
                setChatResponseStatuses((current) => {
                    if (!(streamChatId! in current)) return current;
                    const next = { ...current };
                    delete next[streamChatId!];
                    return next;
                });
            }
            // Superseded stream: the list it would repaint is someone
            // else's now.
            if (streamGenerationRef.current !== gen) return;

            const isAbort = err instanceof Error && err.name === "AbortError";
            stopDrip();
            clearStreamingPlaceholders();
            setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant") {
                    // Whatever arrived before the break is real answer text
                    // and stays on screen; only the streaming state is closed.
                    updated[updated.length - 1] = {
                        ...last,
                        isStreaming: false,
                    };
                }
                return updated;
            });
            // The failure used to be written into the answer as if the model
            // had said it, which left no way to tell a real answer from a
            // transport error and offered nothing to do about it.
            notifyError(err, {
                action: "finish this answer",
                fallback:
                    "The answer stopped before it finished. Anything already shown is kept.",
                dedupeKey: `tr-chat-stream:${reviewId}`,
                onRetry: isAbort
                    ? undefined
                    : retryThisTurn,
            });
        } finally {
            if (streamGenerationRef.current === gen) setIsLoading(false);
            if (abortRef.current === controller) abortRef.current = null;
        }
    }

    // ---- render ----

    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    const lastAssistantIdx = messages
        .map((m) => m.role)
        .lastIndexOf("assistant");

    return (
        <div
            style={
                {
                    "--tr-chat-panel-width": `${panelWidth}px`,
                } as CSSProperties
            }
            className={cn(
                "flex flex-col relative",
                // Mobile: replaces the table, filling the row minus margins.
                // md+: fixed width beside the table, top-aligned with it
                // (below the toolbar).
                "flex-1 min-w-0 mx-3 mb-3 md:flex-none md:w-[var(--tr-chat-panel-width)] md:mt-12 md:-ml-6 md:mr-6",
                "rounded-2xl",
                LIQUID_GLASS_FLAT_CLASS,
                "overflow-hidden",
            )}
        >
            {/* Resize handle */}
            <div
                onMouseDown={(e) => {
                    e.preventDefault();
                    resizeStartRef.current = {
                        x: e.clientX,
                        width: panelWidth,
                    };
                    setIsResizing(true);
                }}
                className={`absolute top-0 left-0 h-full w-1 cursor-col-resize z-20 transition-colors hidden md:block ${
                    isResizing
                        ? "bg-blue-400/70"
                        : "bg-transparent hover:bg-blue-400/70"
                }`}
            />
            {/* Header — fixed, overlaid on top of the messages */}
            <div className="absolute inset-x-0 top-0 z-10">
                <ChatPanelHeader
                    chats={chats}
                    currentChatId={currentChatId ?? ""}
                    currentTitle={currentChatTitle}
                    loading={isLoadingChats}
                    responseStatuses={chatResponseStatuses}
                    newChatDisabled={!canSend || isLoading}
                    onLoad={(chatId) => void handleLoadChat(chatId)}
                    onNewChat={handleNewChat}
                    titleEdit={
                        titleDraft !== null
                            ? {
                                  value: titleDraft,
                                  onChange: setTitleDraft,
                                  onSave: () => {
                                      const title = titleDraft.trim();
                                      setTitleDraft(null);
                                      if (
                                          currentChatId &&
                                          title &&
                                          title !== currentChatTitle
                                      ) {
                                          void handleRenameChat(
                                              currentChatId,
                                              title,
                                          );
                                      }
                                  },
                                  onCancel: () => setTitleDraft(null),
                              }
                            : undefined
                    }
                    actions={
                        currentChatId ? (
                            <HeaderActionsMenu
                                triggerClassName="h-6 w-6"
                                onCloseAutoFocus={(event) => {
                                    if (titleDraft !== null)
                                        event.preventDefault();
                                }}
                                items={[
                                    {
                                        label: "Rename",
                                        icon: Pencil,
                                        onSelect: () =>
                                            setTitleDraft(
                                                currentChatTitle ?? "New Chat",
                                            ),
                                        disabled:
                                            !canSend ||
                                            isLoadingChats ||
                                            isLoadingMessages ||
                                            isLoading,
                                    },
                                    {
                                        label: "Delete",
                                        icon: Trash2,
                                        onSelect: () => {
                                            if (currentChatId)
                                                void handleDeleteChat(
                                                    currentChatId,
                                                );
                                        },
                                        disabled:
                                            !canSend ||
                                            isLoadingChats ||
                                            isLoadingMessages ||
                                            isLoading,
                                        variant: "danger",
                                    },
                                ]}
                            />
                        ) : null
                    }
                />
            </div>

            {/* Messages and loading skeleton share the spacer's top inset. */}
            <div
                ref={messagesContainerRef}
                className="tr-chat-message-fades flex-1 overflow-y-auto px-4 flex flex-col"
                style={{
                    paddingTop: MESSAGE_TOP_INSET,
                    paddingBottom: Math.ceil(inputHeight + COMPOSER_GAP),
                }}
            >
                {isLoadingMessages && (
                    <div className="flex flex-col gap-4">
                        <div className="flex justify-end">
                            <div className="bg-gray-100 rounded-2xl p-3 w-3/5">
                                <div className="theme-shimmer h-3 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                            </div>
                        </div>
                        <div className="space-y-2">
                            {[1, 2, 3, 4].map((i) => (
                                <div
                                    key={i}
                                    className={`theme-shimmer h-3 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
                                />
                            ))}
                        </div>
                    </div>
                )}
                {messages.length > 0 && (
                    <div
                        className="flex flex-col gap-4 transition-opacity duration-150"
                        style={{ opacity: messagesVisible ? 1 : 0 }}
                    >
                        {messages.map((msg, i) => (
                            <div
                                key={i}
                                ref={
                                    i === lastUserIdx
                                        ? latestUserMessageRef
                                        : null
                                }
                                style={
                                    i === lastAssistantIdx
                                        ? { minHeight }
                                        : undefined
                                }
                            >
                                <MessageBubble
                                    msg={msg}
                                    onCitationClick={onCitationClick}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Input */}
            <div
                ref={composerRef}
                className="absolute bottom-0 left-0 right-0 z-10 px-3 pb-3"
            >
                <ChatInput
                    onSubmit={(message) => void handleSubmit(message)}
                    onCancel={handleCancel}
                    isLoading={isLoading}
                    canSend={canSend}
                    hideAddDocButton
                    hideWorkflowButton
                    chatModel={currentChatModel}
                    chatReasoningLevel={currentChatReasoningLevel}
                    chatKey={
                        currentChatId
                            ? tabularChatSelectionKey(reviewId, currentChatId)
                            : null
                    }
                />
            </div>
            <ApiKeyMissingPopup
                open={rejectedApiKey !== null}
                title="API key rejected"
                message={`${
                    rejectedApiKey?.provider
                        ? `The ${providerLabel(rejectedApiKey.provider)} API key`
                        : "That API key"
                } was rejected. If it is your own key, check it in Settings; otherwise contact your administrator.`}
                onClose={() => setRejectedApiKey(null)}
            />
        </div>
    );
}
