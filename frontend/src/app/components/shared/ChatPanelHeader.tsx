"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import type { Chat } from "@/app/components/shared/types";
import { ChatSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { FormTextInput } from "@/app/components/ui/form-field";
import {
    ChatHistoryDropdownUI,
    type ChatHistoryDropdownItemUI,
} from "@/shared/ui/ChatHistoryDropdownUI";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";
import { formatElapsedTime } from "@/app/lib/formatElapsedTime";
import { chatActivityAt, sortChatsByActivity } from "@/app/lib/chatActivity";

const HEADER_PILL_CLASS = `flex shrink-0 items-center gap-1 rounded-full px-1 py-0.5 ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl`;
const HEADER_PILL_BUTTON_CLASS = `flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${LIQUID_GLASS_HOVER_CLASS}`;

interface ChatPanelHeaderProps {
    chats: (Pick<Chat, "id" | "title"> &
        Partial<Pick<Chat, "created_at" | "updated_at">>)[];
    currentChatId: string;
    currentTitle: string | null;
    loading?: boolean;
    responseStatuses?: Record<string, "loading" | "complete">;
    newChatDisabled?: boolean;
    actions: ReactNode;
    onLoad: (chatId: string) => void;
    onNewChat: () => void;
    titleEdit?: {
        value: string;
        onChange: (title: string) => void;
        onSave: () => void;
        onCancel: () => void;
    };
}

export function ChatPanelHeader({
    chats,
    currentChatId,
    currentTitle,
    loading = false,
    responseStatuses = {},
    newChatDisabled = false,
    actions,
    onLoad,
    onNewChat,
    titleEdit,
}: ChatPanelHeaderProps) {
    const [historyOpen, setHistoryOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [now, setNow] = useState(Date.now);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const editingTitle = !!titleEdit;
    const [previousEditingTitle, setPreviousEditingTitle] =
        useState(editingTitle);
    if (previousEditingTitle !== editingTitle) {
        setPreviousEditingTitle(editingTitle);
        if (editingTitle) setHistoryOpen(false);
    }
    const filteredChats = sortChatsByActivity(chats).filter((chat) =>
            (chat.title ?? "New Chat")
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
        );

    useEffect(() => {
        if (!editingTitle) return;
        // Wait for the actions menu to release its focus trap before focusing.
        const timer = window.setTimeout(
            () => titleInputRef.current?.focus(),
            0,
        );
        return () => window.clearTimeout(timer);
    }, [editingTitle]);

    useEffect(() => {
        if (!historyOpen) return;
        const interval = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(interval);
    }, [historyOpen]);

    const historyItems: ChatHistoryDropdownItemUI[] = filteredChats.map(
        (chat) => {
            const title = chat.title ?? "New Chat";
            const activityAt = chatActivityAt(chat);
            const elapsed = formatElapsedTime(activityAt, now);
            const responseStatus = responseStatuses[chat.id];
            return {
                id: chat.id,
                title,
                current: chat.id === currentChatId,
                icon:
                    responseStatus === "loading" ? (
                        <Loader2
                            role="status"
                            aria-label={`${title} response loading`}
                            className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600 motion-reduce:animate-none"
                        />
                    ) : (
                        <ChatSkeuoIcon
                            aria-hidden="true"
                            tone={
                                responseStatus === "complete" ? "green" : "blue"
                            }
                            className="h-3.5 w-3.5 shrink-0"
                        />
                    ),
                time:
                    elapsed && activityAt
                        ? {
                              label: elapsed,
                              dateTime: activityAt,
                              description: `Updated ${new Date(activityAt).toLocaleString()}`,
                          }
                        : undefined,
            };
        },
    );

    function loadChat(chatId: string) {
        setHistoryOpen(false);
        setQuery("");
        if (chatId === currentChatId) return;
        onLoad(chatId);
    }

    return (
        <div className="pointer-events-none flex h-12 shrink-0 items-center justify-between gap-2 bg-transparent pl-2 pr-3">
            <div className="pointer-events-auto relative min-w-0 shrink">
                {titleEdit ? (
                    <div className={cn(HEADER_PILL_CLASS, "min-w-0")}>
                        <FormTextInput
                            ref={titleInputRef}
                            variant="minimal"
                            aria-label="Chat title"
                            value={titleEdit.value}
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) =>
                                titleEdit.onChange(event.target.value)
                            }
                            onBlur={titleEdit.onSave}
                            onKeyDown={(event) => {
                                if (event.nativeEvent.isComposing) return;
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    titleEdit.onSave();
                                } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    titleEdit.onCancel();
                                }
                            }}
                            className="h-6 w-48 max-w-full rounded-full border-0 bg-transparent px-1.5 font-sans text-xs font-medium text-gray-700 shadow-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-0"
                        />
                    </div>
                ) : (
                    <div className={cn(HEADER_PILL_CLASS, "min-w-0")}>
                        <ChatHistoryDropdownUI
                            open={historyOpen}
                            onOpenChange={(open) => {
                                if (open) setNow(Date.now());
                                setHistoryOpen(open);
                            }}
                            trigger={
                                <button
                                    type="button"
                                    className={cn(
                                        "flex h-6 min-w-0 items-center gap-1 rounded-full px-1.5 text-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                                        LIQUID_GLASS_HOVER_CLASS,
                                    )}
                                >
                                    <span className="min-w-0 truncate text-xs font-medium">
                                        {currentTitle ?? "New Chat"}
                                    </span>
                                    <ChevronDown
                                        className={cn(
                                            "h-3 w-3 shrink-0 text-gray-600 transition-transform duration-200",
                                            historyOpen && "rotate-180",
                                        )}
                                    />
                                </button>
                            }
                            query={query}
                            onQueryChange={setQuery}
                            loading={loading}
                            emptyLabel={
                                chats.length === 0
                                    ? "No chats yet."
                                    : "No matches."
                            }
                            items={historyItems}
                            onSelect={loadChat}
                        />
                    </div>
                )}
            </div>

            {(currentChatId || actions) && (
                <div className="pointer-events-auto flex shrink-0 items-center">
                    <div className={cn(HEADER_PILL_CLASS, "px-0.5")}>
                        {currentChatId && (
                            <button
                                type="button"
                                onClick={onNewChat}
                                disabled={newChatDisabled}
                                aria-label="New chat"
                                className={cn(
                                    HEADER_PILL_BUTTON_CLASS,
                                    "disabled:cursor-not-allowed disabled:opacity-40",
                                )}
                            >
                                <Plus
                                    aria-hidden="true"
                                    className="h-3.5 w-3.5"
                                />
                            </button>
                        )}
                        {actions}
                    </div>
                </div>
            )}
        </div>
    );
}
