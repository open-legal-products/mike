import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { ArrowDown } from "lucide-react";
import { AssistantMessage } from "./AssistantMessage";
import { ChatInput } from "./ChatInput";
import type { ChatInputHandle } from "./ChatInput";
import { InitialView } from "./InitialView";
import { UserMessage } from "./UserMessage";
import type {
    EditDecision,
    ReasoningLevel,
    WordAssistantChatController,
    WordTrackedEditsController,
    WorkflowAttachment,
} from "../../lib/wordChatTypes";
import type { WordEditApplyMode } from "../../lib/wordChatSettings";
import { selectDocumentText } from "../../hooks/useWordDoc";
import { UserVisibleError, notifyError } from "../../lib/notify";

const CHAT_MESSAGE_TOP_GAP = 12;
const CHAT_MESSAGES_BOTTOM_GAP = 16;
// The submitted user turn always settles on the transcript's existing pt-20
// line. The spacer and scroll destination must share this exact value so a
// short and long response cannot settle at different vertical positions.
const PIN_TOP_OFFSET = 80;

interface ChatViewProps
    extends WordAssistantChatController,
        Pick<
            WordTrackedEditsController,
            | "editStateByKey"
            | "applyEdit"
            | "viewEdit"
            | "resolveOneEdit"
            | "resolveMessageEdits"
            | "acceptAndApplyEdit"
        > {
    sessionKey: number;
    chatModel?: string | null;
    lastSelectedModel?: string | null;
    chatReasoningLevel?: ReasoningLevel | null;
    lastSelectedReasoningLevel: ReasoningLevel;
    onModelSelected: (model: string) => Promise<void>;
    onReasoningSelected: (level: ReasoningLevel) => Promise<void>;
    selectedWorkflow: WorkflowAttachment | null;
    onSelectedWorkflowChange: (workflow: WorkflowAttachment | null) => void;
    editApplyMode: WordEditApplyMode;
    onEditApplyModeChange: (mode: WordEditApplyMode) => void;
}

/**
 * Room reserved under the latest user turn so it can pin near the top while
 * the answer streams into the gap: the last assistant message is inflated via
 * min-height, sized against the live container geometry.
 */
function measureSpacerPx(
    container: HTMLElement,
    latestUser: HTMLElement,
    bottomInset: number,
): number {
    const containerStyle = window.getComputedStyle(container);
    const messageGap = Number.parseFloat(containerStyle.rowGap) || 0;
    return Math.max(
        0,
        container.clientHeight -
            PIN_TOP_OFFSET -
            latestUser.offsetHeight -
            messageGap * 2 -
            bottomInset,
    );
}

const PIN_SCROLL_DURATION_MS = 200;

// How long after a user input its scroll events remain user-owned. Wheel and
// keyboard repeat within this window; macOS momentum wheel events keep
// re-arming it. Touch momentum outlives the last touch event, so touch
// releases arm a longer window.
const USER_SCROLL_GRACE_MS = 250;
const TOUCH_SCROLL_GRACE_MS = 2000;

/**
 * rAF-driven pin scroll. Native `scrollTo({behavior: "smooth"})` is not
 * animated in every Office webview (WKWebView can execute it as an instant
 * jump), so the pin scroll drives its own easing. Matching native semantics,
 * the target is clamped to the scroll range ONCE at start and never extended:
 * content that streams in later must not move a settled transcript. Returns a
 * cancel function; ChatView owns all user-input cancellation. `onFrame`
 * reports every position the animation writes, so the caller can track the
 * last application-owned scroll position frame by frame.
 */
function animateScrollTo(
    container: HTMLElement,
    targetTop: number,
    onFrame?: (top: number) => void,
    duration = PIN_SCROLL_DURATION_MS,
): () => void {
    const startTop = container.scrollTop;
    const clampedTarget = Math.max(
        0,
        Math.min(targetTop, container.scrollHeight - container.clientHeight),
    );
    const reducedMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || duration <= 0) {
        container.scrollTop = clampedTarget;
        onFrame?.(clampedTarget);
        return () => {};
    }
    const startTime = performance.now();
    let frame: number | null = null;
    let done = false;
    const cleanup = (): void => {
        done = true;
        if (frame !== null) cancelAnimationFrame(frame);
    };
    const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
    const step = (now: number): void => {
        if (done) return;
        const progress = Math.min(1, (now - startTime) / duration);
        const nextTop =
            startTop + (clampedTarget - startTop) * easeOutCubic(progress);
        container.scrollTop = nextTop;
        onFrame?.(nextTop);
        if (progress < 1) {
            frame = requestAnimationFrame(step);
        } else {
            cleanup();
        }
    };
    frame = requestAnimationFrame(step);
    return cleanup;
}

export function ChatView({
    sessionKey,
    chatModel,
    lastSelectedModel,
    chatReasoningLevel,
    lastSelectedReasoningLevel,
    onModelSelected,
    onReasoningSelected,
    messages,
    isResponseLoading,
    requestError,
    handleChat,
    cancel,
    dismissRequestError,
    editStateByKey,
    applyEdit,
    viewEdit,
    resolveOneEdit,
    resolveMessageEdits,
    acceptAndApplyEdit,
    selectedWorkflow,
    onSelectedWorkflowChange,
    editApplyMode,
    onEditApplyModeChange,
}: ChatViewProps): React.ReactElement {
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const composerRef = useRef<HTMLDivElement>(null);
    const chatInputRef = useRef<ChatInputHandle>(null);
    const latestUserMessageRef = useRef<HTMLDivElement | null>(null);
    const latestUserMessageDetailsRef = useRef<{
        id: string | null;
        content: string | null;
    }>({ id: null, content: null });
    // The user-turn id whose spacer has been reserved (pre-paint).
    const spacerHandledIdRef = useRef<string | null>(null);
    // The user-turn id whose pin scroll has been requested.
    const scrollHandledIdRef = useRef<string | null>(null);
    // Invalidates in-flight scroll requests on session switches.
    const scrollVersionRef = useRef(0);
    // Cancels the active pin-scroll animation, if any.
    const cancelPinScrollRef = useRef<(() => void) | null>(null);
    // True only while the application still owns the latest turn's anchor.
    // Any direct user navigation or the bottom arrow relinquishes ownership.
    const anchorActiveRef = useRef(false);
    // WebKit can adjust scrollTop when descendants resize even though the
    // transcript disables CSS scroll anchoring. Keep the last application- or
    // user-owned position so a resize can restore it explicitly.
    const desiredScrollTopRef = useRef(0);
    // Scroll ownership for engine-scroll correction: while a pointer/touch is
    // held, or briefly after any user input, scroll events are the user's and
    // desiredScrollTopRef follows them. Outside those windows a scroll event
    // the application did not write is engine-initiated (WKWebView anchoring
    // or bottom-follow) and gets snapped back to the owned position.
    const userInputOwnedUntilRef = useRef(0);
    const pointerHeldRef = useRef(false);
    const showScrollButtonRef = useRef(false);
    // False until the first positioning pass after mount / session switch.
    const hasPositionedRef = useRef(false);
    const [composerHeight, setComposerHeight] = useState(144);
    const [assistantMinHeight, setAssistantMinHeight] = useState("0px");
    const [messagesVisible, setMessagesVisible] = useState(false);
    const [showScrollButton, setShowScrollButton] = useState(false);
    const messagesBottomInset = composerHeight + CHAT_MESSAGES_BOTTOM_GAP;

    let latestUserIndex = -1;
    let latestAssistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message) continue;
        if (latestUserIndex < 0 && message.role === "user") {
            latestUserIndex = index;
        }
        if (latestAssistantIndex < 0 && message.role === "assistant") {
            latestAssistantIndex = index;
        }
        if (latestUserIndex >= 0 && latestAssistantIndex >= 0) break;
    }
    const latestUserMessageId =
        latestUserIndex >= 0 ? (messages[latestUserIndex]?.id ?? null) : null;
    const latestUserMessage =
        latestUserIndex >= 0 ? (messages[latestUserIndex] ?? null) : null;
    const latestUserMessageContent =
        latestUserMessage?.role === "user" ? latestUserMessage.content : null;
    latestUserMessageDetailsRef.current = {
        id: latestUserMessageId,
        content: latestUserMessageContent,
    };
    const latestAssistantMessageId =
        latestAssistantIndex > latestUserIndex
            ? (messages[latestAssistantIndex]?.id ?? null)
            : null;
    const hasMessages = messages.length > 0;

    // Stable handlers so memoized message rows do not re-render per chunk.
    const handleApplyEdit = useCallback(
        (key: string) => {
            applyEdit(key);
        },
        [applyEdit],
    );
    const handleViewEdit = useCallback(
        (key: string) => {
            void viewEdit(key);
        },
        [viewEdit],
    );
    const handleResolveEdit = useCallback(
        (key: string, decision: EditDecision) => {
            void resolveOneEdit(key, decision);
        },
        [resolveOneEdit],
    );
    const handleResolveAll = useCallback(
        (keys: string[], decision: EditDecision) => {
            void resolveMessageEdits(keys, decision);
        },
        [resolveMessageEdits],
    );
    const handleAcceptAndApplyEdit = useCallback(
        (key: string) => {
            void acceptAndApplyEdit(key);
        },
        [acceptAndApplyEdit],
    );
    // Citation chips: scroll Word to the cited passage and select it. Kept
    // identity-stable so memoized message rows never re-render per chunk.
    const handleLocateCitation = useCallback((text: string) => {
        void selectDocumentText(text).then((status) => {
            // Clicking a citation and having nothing move is indistinguishable
            // from a frozen pane, so both failure modes say which one it was.
            if (status === "selected") return;
            notifyError(
                new UserVisibleError(
                    status === "not-found"
                        ? "Mike couldn't find that passage in this document. It may have changed since the answer was written."
                        : "Word couldn't scroll to that passage. Try finding it with Word's search.",
                    { kind: status === "not-found" ? "not_found" : "unknown" },
                ),
                {
                    action: "go to that passage",
                    dedupeKey: "citation-locate",
                    page: "Assistant",
                },
            );
        });
    }, []);

    const updateScrollButton = useCallback(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        const bottomDistance =
            container.scrollHeight -
            container.scrollTop -
            container.clientHeight;
        const isScrollable = container.scrollHeight > container.clientHeight;
        const isScrolledUp = bottomDistance > 10;
        const nextVisible = isScrolledUp && isScrollable;
        if (showScrollButtonRef.current === nextVisible) return;
        showScrollButtonRef.current = nextVisible;
        setShowScrollButton(nextVisible);
    }, []);

    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container) return;
        const ownScrollForUser = (graceMs: number): void => {
            userInputOwnedUntilRef.current = Math.max(
                userInputOwnedUntilRef.current,
                performance.now() + graceMs,
            );
        };
        const cancelForUser = (): void => {
            anchorActiveRef.current = false;
            cancelPinScrollRef.current?.();
            cancelPinScrollRef.current = null;
            ownScrollForUser(USER_SCROLL_GRACE_MS);
            // Wheel/touch/keyboard scrolling is applied after the input event.
            // Capture the resulting position on the next frame, before any
            // later streamed resize is allowed to preserve it.
            requestAnimationFrame(() => {
                if (messagesContainerRef.current === container) {
                    desiredScrollTopRef.current = container.scrollTop;
                }
            });
        };
        const holdPointer = (): void => {
            pointerHeldRef.current = true;
            cancelForUser();
        };
        const releasePointer = (graceMs: number) => (): void => {
            pointerHeldRef.current = false;
            ownScrollForUser(graceMs);
        };
        const releaseTouch = releasePointer(TOUCH_SCROLL_GRACE_MS);
        const releaseMouse = releasePointer(USER_SCROLL_GRACE_MS);
        const cancelForKeyboard = (event: KeyboardEvent): void => {
            if (
                event.key === "ArrowUp" ||
                event.key === "ArrowDown" ||
                event.key === "PageUp" ||
                event.key === "PageDown" ||
                event.key === "Home" ||
                event.key === "End" ||
                event.key === " "
            ) {
                cancelForUser();
            }
        };
        // WKWebView sometimes rewrites a scroller's position on its own —
        // its scroll-anchoring heuristics run even though the transcript sets
        // `overflow-anchor: none` (WebKit does not support the property):
        // unmounting the node it anchored to can reset scrollTop to 0, and a
        // bottom-resting scroller is dragged along as streamed content grows.
        // Every position the application writes is mirrored into
        // desiredScrollTopRef first, and user input marks its ownership
        // window before its scroll events land — so any other scroll event is
        // engine-initiated and gets snapped back to the owned position.
        const correctEngineScroll = (): void => {
            if (anchorActiveRef.current) {
                const desired = desiredScrollTopRef.current;
                if (Math.abs(container.scrollTop - desired) > 1) {
                    container.scrollTop = desired;
                }
            } else if (
                pointerHeldRef.current ||
                performance.now() <= userInputOwnedUntilRef.current
            ) {
                desiredScrollTopRef.current = container.scrollTop;
            } else {
                const preserved = Math.max(
                    0,
                    Math.min(
                        desiredScrollTopRef.current,
                        container.scrollHeight - container.clientHeight,
                    ),
                );
                if (Math.abs(container.scrollTop - preserved) > 1) {
                    desiredScrollTopRef.current = preserved;
                    container.scrollTop = preserved;
                }
            }
            updateScrollButton();
        };
        container.addEventListener("scroll", correctEngineScroll);
        container.addEventListener("wheel", cancelForUser, { passive: true });
        container.addEventListener("touchstart", holdPointer, {
            passive: true,
        });
        window.addEventListener("touchend", releaseTouch, { passive: true });
        window.addEventListener("touchcancel", releaseTouch, {
            passive: true,
        });
        container.addEventListener("pointerdown", holdPointer, {
            passive: true,
        });
        window.addEventListener("pointerup", releaseMouse, { passive: true });
        window.addEventListener("pointercancel", releaseMouse, {
            passive: true,
        });
        window.addEventListener("keydown", cancelForKeyboard, true);
        // eslint-disable-next-line react-hooks/set-state-in-effect -- initial scroll-button state must be measured from the live DOM
        updateScrollButton();
        return () => {
            container.removeEventListener("scroll", correctEngineScroll);
            container.removeEventListener("wheel", cancelForUser);
            container.removeEventListener("touchstart", holdPointer);
            window.removeEventListener("touchend", releaseTouch);
            window.removeEventListener("touchcancel", releaseTouch);
            container.removeEventListener("pointerdown", holdPointer);
            window.removeEventListener("pointerup", releaseMouse);
            window.removeEventListener("pointercancel", releaseMouse);
            window.removeEventListener("keydown", cancelForKeyboard, true);
        };
    }, [hasMessages, updateScrollButton]);

    const scrollToBottom = (): void => {
        const container = messagesContainerRef.current;
        if (!container) return;
        anchorActiveRef.current = false;
        cancelPinScrollRef.current?.();
        cancelPinScrollRef.current = null;
        const bottomTop = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
        );
        desiredScrollTopRef.current = bottomTop;
        container.scrollTop = bottomTop;
        updateScrollButton();
    };

    useLayoutEffect(() => {
        scrollVersionRef.current += 1;
        cancelPinScrollRef.current?.();
        cancelPinScrollRef.current = null;
        anchorActiveRef.current = false;
        desiredScrollTopRef.current = 0;
        userInputOwnedUntilRef.current = 0;
        pointerHeldRef.current = false;
        spacerHandledIdRef.current = null;
        scrollHandledIdRef.current = null;
        hasPositionedRef.current = false;
        setAssistantMinHeight("0px");
        setMessagesVisible(false);
        showScrollButtonRef.current = false;
        setShowScrollButton(false);
    }, [sessionKey]);

    useEffect(
        () => () => {
            cancelPinScrollRef.current?.();
        },
        [],
    );

    // ── Live sends: pre-paint space reservation ─────────────────────────────
    // Runs in the commit that appends a new user turn, BEFORE the browser
    // paints it. It reserves the assistant spacer by writing min-height
    // straight to the DOM and mirroring that value into state, and reveals
    // the transcript — so the first painted frame already has its final
    // geometry. The old code did all of this in post-paint effects, and the
    // late spacer pop was the visible layout shift on send. The pin scroll is
    // NOT started here: it is the turn's one intentional motion and must
    // begin only after the hook starts consuming the stream (see
    // requestTurnLayout).
    //
    // Restored transcripts deliberately do NOT take this path (see the effect
    // below): their positioning stays post-paint behind the opacity gate, and
    // the scroll-to-bottom button intentionally reflects the pre-positioning
    // scroll state so a long history reveals the control on load.
    useLayoutEffect(() => {
        if (!isResponseLoading) return;
        const container = messagesContainerRef.current;
        const userEl = latestUserMessageRef.current;
        if (!container || !userEl || !latestUserMessageId) return;
        if (spacerHandledIdRef.current === latestUserMessageId) return;
        spacerHandledIdRef.current = latestUserMessageId;
        hasPositionedRef.current = true;
        anchorActiveRef.current = true;

        const spacerPx = measureSpacerPx(
            container,
            userEl,
            messagesBottomInset,
        );
        const assistantEl = userEl.nextElementSibling as HTMLElement | null;
        if (assistantEl?.hasAttribute("data-assistant-message-id")) {
            assistantEl.style.minHeight = `${spacerPx}px`;
        }
        setAssistantMinHeight(`${spacerPx}px`);
        setMessagesVisible(true);
    }, [latestUserMessageId, isResponseLoading, messagesBottomInset]);

    // ── Restored transcripts: masked post-paint positioning ────────────────
    // Mirrors the frontend assistant: the list mounts at opacity 0 (so refs
    // are measurable but nothing is visible), the spacer is applied, and for
    // multi-turn histories an instant scroll pins the latest turn before the
    // reveal. The 100ms delay lets the transcript finish its first commit in
    // the mocked and real Office hosts alike.
    useEffect(() => {
        if (messages.length === 0) {
            hasPositionedRef.current = false;
            setMessagesVisible(false);
            return;
        }
        if (hasPositionedRef.current) return;

        const container = messagesContainerRef.current;
        const userEl = latestUserMessageRef.current;
        if (container && userEl) {
            setAssistantMinHeight(
                `${measureSpacerPx(container, userEl, messagesBottomInset)}px`,
            );
        }

        const questions = messages.filter(
            (message) => message.role === "user",
        ).length;
        if (questions < 2) {
            hasPositionedRef.current = true;
            anchorActiveRef.current = true;
            spacerHandledIdRef.current = latestUserMessageId;
            scrollHandledIdRef.current = latestUserMessageId;
            setMessagesVisible(true);
            return;
        }

        const timer = window.setTimeout(() => {
            const timedContainer = messagesContainerRef.current;
            const element = latestUserMessageRef.current;
            if (timedContainer && element) {
                const restoredTop = Math.max(
                    0,
                    element.offsetTop - PIN_TOP_OFFSET,
                );
                desiredScrollTopRef.current = restoredTop;
                timedContainer.scrollTo({
                    top: restoredTop,
                    behavior: "instant",
                });
            }
            hasPositionedRef.current = true;
            anchorActiveRef.current = true;
            spacerHandledIdRef.current = latestUserMessageId;
            scrollHandledIdRef.current = latestUserMessageId;
            setMessagesVisible(true);
        }, 100);
        return () => window.clearTimeout(timer);
    }, [messages, latestUserMessageId, messagesBottomInset]);

    // ── Live sends: the pin scroll ──────────────────────────────────────────
    // The chat hook calls this right before it starts consuming the response
    // stream (two rAFs after the append commit). By then the pre-paint spacer
    // is installed, so this callback owns the turn's only pin operation.
    const requestTurnLayout = useCallback(() => {
        const { id } = latestUserMessageDetailsRef.current;
        if (!id || scrollHandledIdRef.current === id) return;
        scrollHandledIdRef.current = id;
        const requestedVersion = scrollVersionRef.current;
        if (requestedVersion !== scrollVersionRef.current) return;
        const container = messagesContainerRef.current;
        const element = latestUserMessageRef.current;
        if (!container || !element || element.dataset.messageId !== id) return;
        anchorActiveRef.current = true;
        cancelPinScrollRef.current?.();
        const targetTop = Math.max(0, element.offsetTop - PIN_TOP_OFFSET);
        desiredScrollTopRef.current = targetTop;
        cancelPinScrollRef.current = animateScrollTo(
            container,
            targetTop,
            (top) => {
                desiredScrollTopRef.current = top;
            },
        );
    }, []);

    // Keep the reserved spacer in sync with the pane size (Word task panes
    // resize freely). Content growth never triggers this — the spacer stays
    // frozen while an answer streams, which keeps the pinned turn steady.
    useEffect(() => {
        const container = messagesContainerRef.current;
        if (!container || typeof ResizeObserver === "undefined") return;
        let previousWidth = container.clientWidth;
        let previousHeight = container.clientHeight;
        let resizeFrame: number | null = null;
        const observer = new ResizeObserver(() => {
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = null;
                const nextWidth = container.clientWidth;
                const nextHeight = container.clientHeight;
                if (
                    nextWidth === previousWidth &&
                    nextHeight === previousHeight
                ) {
                    return;
                }
                previousWidth = nextWidth;
                previousHeight = nextHeight;
                const userEl = latestUserMessageRef.current;
                if (!userEl) return;
                // Width-only resizes matter too: narrowing the pane re-wraps
                // the pinned turn and changes the correct reservation. An
                // unchanged result no-ops via the useState string bailout, so
                // the initial observe fire is harmless.
                const spacerPx = measureSpacerPx(
                    container,
                    userEl,
                    messagesBottomInset,
                );
                const assistantEl =
                    userEl.nextElementSibling as HTMLElement | null;
                if (assistantEl?.hasAttribute("data-assistant-message-id")) {
                    assistantEl.style.minHeight = `${spacerPx}px`;
                }
                setAssistantMinHeight(`${spacerPx}px`);
                if (anchorActiveRef.current) {
                    const anchoredTop = Math.max(
                        0,
                        userEl.offsetTop - PIN_TOP_OFFSET,
                    );
                    desiredScrollTopRef.current = anchoredTop;
                    container.scrollTop = anchoredTop;
                } else {
                    const preservedTop = Math.max(
                        0,
                        Math.min(
                            desiredScrollTopRef.current,
                            container.scrollHeight - container.clientHeight,
                        ),
                    );
                    desiredScrollTopRef.current = preservedTop;
                    container.scrollTop = preservedTop;
                }
                updateScrollButton();
            });
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        };
    }, [hasMessages, messagesBottomInset, updateScrollButton]);

    // The container's border box does not change when streamed content grows
    // or an activity card collapses. Observe the active assistant row so the
    // arrow reflects real overflow without rebinding the scroll listener for
    // every `messages` object produced by the stream.
    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const assistantEl =
            userEl?.nextElementSibling instanceof HTMLElement
                ? userEl.nextElementSibling
                : null;
        if (!assistantEl || typeof ResizeObserver === "undefined") return;
        let frame: number | null = null;
        const observer = new ResizeObserver(() => {
            if (frame !== null) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                frame = null;
                const container = messagesContainerRef.current;
                const currentUser = latestUserMessageRef.current;
                if (!container || !currentUser) return;
                if (anchorActiveRef.current) {
                    const anchoredTop = Math.max(
                        0,
                        currentUser.offsetTop - PIN_TOP_OFFSET,
                    );
                    desiredScrollTopRef.current = anchoredTop;
                    container.scrollTop = anchoredTop;
                } else {
                    const preservedTop = Math.max(
                        0,
                        Math.min(
                            desiredScrollTopRef.current,
                            container.scrollHeight - container.clientHeight,
                        ),
                    );
                    desiredScrollTopRef.current = preservedTop;
                    container.scrollTop = preservedTop;
                }
                updateScrollButton();
            });
        });
        observer.observe(assistantEl);
        return () => {
            observer.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [latestAssistantMessageId, updateScrollButton]);

    useEffect(() => {
        const composer = composerRef.current;
        if (!composer) return;
        const updateHeight = (): void => {
            const nextHeight = composer.offsetHeight;
            setComposerHeight((current) =>
                Math.abs(current - nextHeight) < 1 ? current : nextHeight,
            );
        };
        updateHeight();
        if (typeof ResizeObserver === "undefined") return;
        let resizeFrame: number | null = null;
        const observer = new ResizeObserver(() => {
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = null;
                updateHeight();
            });
        });
        observer.observe(composer);
        return () => {
            observer.disconnect();
            if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
        };
    }, []);

    return (
        <div className="relative h-full overflow-hidden">
            {!hasMessages && !isResponseLoading ? (
                <div
                    className="flex h-full flex-col items-center justify-center overflow-y-auto px-6 pt-20"
                    style={{ paddingBottom: composerHeight + 16 }}
                >
                    <InitialView
                        onSelect={(action) => {
                            onSelectedWorkflowChange(action.workflow);
                            chatInputRef.current?.setDraft(action.prompt);
                        }}
                    />
                </div>
            ) : (
                <div
                    ref={messagesContainerRef}
                    data-testid="messages-container"
                    className="relative flex h-full scroll-pt-20 flex-col gap-4 overflow-y-auto px-6 pt-20 transition-opacity duration-150 [overflow-anchor:none]"
                    style={{
                        opacity: messagesVisible ? 1 : 0,
                    }}
                >
                    {messages.map((message, index) => {
                        if (message.role === "user") {
                            return (
                                <div
                                    key={message.id}
                                    ref={
                                        message.id === latestUserMessageId
                                            ? latestUserMessageRef
                                            : null
                                    }
                                    className="shrink-0 scroll-mt-20"
                                    data-message-id={message.id}
                                >
                                    <UserMessage
                                        content={message.content}
                                        files={message.files}
                                        workflow={message.workflow}
                                    />
                                </div>
                            );
                        }
                        return (
                            <AssistantMessage
                                key={`assistant-${messages[index - 1]?.id ?? index}`}
                                message={message}
                                isStreaming={
                                    index === messages.length - 1 &&
                                    isResponseLoading
                                }
                                minHeight={
                                    message.id === latestAssistantMessageId
                                        ? assistantMinHeight
                                        : undefined
                                }
                                editStateByKey={editStateByKey}
                                onApplyEdit={handleApplyEdit}
                                onViewEdit={handleViewEdit}
                                onResolveEdit={handleResolveEdit}
                                onResolveAll={handleResolveAll}
                                onAcceptAndApplyEdit={handleAcceptAndApplyEdit}
                                onLocateCitation={handleLocateCitation}
                            />
                        );
                    })}
                    {/* WebKit excludes flex end padding from scrollHeight, so
                        reserve the composer inset with a concrete flex item. */}
                    <div
                        ref={messagesEndRef}
                        data-testid="messages-bottom-spacer"
                        className="shrink-0"
                        style={{ height: messagesBottomInset }}
                    />
                </div>
            )}

            {showScrollButton && (
                <div
                    className="absolute left-1/2 z-20 -translate-x-1/2"
                    style={{ bottom: composerHeight + CHAT_MESSAGE_TOP_GAP }}
                >
                    <button
                        type="button"
                        aria-label="Scroll to bottom"
                        onClick={scrollToBottom}
                        className="cursor-pointer rounded-full bg-white/30 p-2 shadow-[0_5px_16px_rgba(15,23,42,0.13),inset_0_1px_0_rgba(255,255,255,0.75),inset_0_-8px_18px_rgba(255,255,255,0.26)] backdrop-blur-xl transition-all hover:bg-white/45 hover:shadow-[0_7px_20px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.85),inset_0_-8px_18px_rgba(255,255,255,0.32)]"
                    >
                        <ArrowDown className="h-5 w-5 text-gray-500" />
                    </button>
                </div>
            )}

            <ChatInput
                ref={chatInputRef}
                containerRef={composerRef}
                sessionKey={sessionKey}
                chatModel={chatModel}
                lastSelectedModel={lastSelectedModel}
                chatReasoningLevel={chatReasoningLevel}
                lastSelectedReasoningLevel={lastSelectedReasoningLevel}
                onModelSelected={onModelSelected}
                onReasoningSelected={onReasoningSelected}
                isResponseLoading={isResponseLoading}
                requestError={requestError}
                selectedWorkflow={selectedWorkflow}
                onSelectedWorkflowChange={onSelectedWorkflowChange}
                onSubmit={handleChat}
                onCancel={cancel}
                onDismissRequestError={dismissRequestError}
                onTurnReady={requestTurnLayout}
                editApplyMode={editApplyMode}
                onEditApplyModeChange={onEditApplyModeChange}
            />
        </div>
    );
}
