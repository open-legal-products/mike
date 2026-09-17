"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Plus, Search } from "lucide-react";
import type { Chat } from "@/app/components/shared/types";
import { FormTextInput } from "@/app/components/ui/form-field";
import {
    LiquidDropdownButton,
    LiquidDropdownSurface,
} from "@/app/components/ui/liquid-dropdown";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";
import { formatElapsedTime } from "@/app/lib/formatElapsedTime";

const HEADER_PILL_CLASS = `flex shrink-0 items-center gap-1 rounded-full px-1 py-0.5 ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl`;
const HEADER_PILL_BUTTON_CLASS = `flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${LIQUID_GLASS_HOVER_CLASS}`;

interface ChatPanelHeaderProps {
    chats: (Pick<Chat, "id" | "title"> & Partial<Pick<Chat, "created_at">>)[];
    currentChatId: string;
    currentTitle: string | null;
    loading?: boolean;
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
    newChatDisabled = false,
    actions,
    onLoad,
    onNewChat,
    titleEdit,
}: ChatPanelHeaderProps) {
    const [historyOpen, setHistoryOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [now, setNow] = useState(Date.now);
    const historyRef = useRef<HTMLDivElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const editingTitle = !!titleEdit;
    const [previousEditingTitle, setPreviousEditingTitle] = useState(editingTitle);
    if (previousEditingTitle !== editingTitle) {
        setPreviousEditingTitle(editingTitle);
        if (editingTitle) setHistoryOpen(false);
    }
    const filteredChats = chats
        .filter((chat) => chat.id !== currentChatId)
        .filter((chat) =>
            (chat.title ?? "New Chat")
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
        );

    useEffect(() => {
        if (!editingTitle) return;
        // Wait for the actions menu to release its focus trap before focusing.
        const timer = window.setTimeout(() => titleInputRef.current?.focus(), 0);
        return () => window.clearTimeout(timer);
    }, [editingTitle]);

    useEffect(() => {
        if (!historyOpen) return;
        const interval = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(interval);
    }, [historyOpen]);

    useEffect(() => {
        if (!historyOpen) return;
        function handlePointerDown(event: MouseEvent) {
            if (
                historyRef.current &&
                !historyRef.current.contains(event.target as Node)
            ) {
                setHistoryOpen(false);
            }
        }
        document.addEventListener("mousedown", handlePointerDown);
        return () =>
            document.removeEventListener("mousedown", handlePointerDown);
    }, [historyOpen]);

    function loadChat(chatId: string) {
        setHistoryOpen(false);
        setQuery("");
        onLoad(chatId);
    }

    return (
        <div className="pointer-events-none flex h-12 shrink-0 items-center justify-between gap-2 bg-transparent pl-2 pr-3">
            <div
                ref={historyRef}
                className="pointer-events-auto relative min-w-0 shrink"
            >
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
                        <button
                            type="button"
                            onClick={() => {
                                setNow(Date.now());
                                setHistoryOpen((open) => !open);
                            }}
                            aria-expanded={historyOpen}
                            aria-haspopup="menu"
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
                    </div>
                )}

                {historyOpen && !titleEdit && (
                    <LiquidDropdownSurface className="absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden">
                        <div className="flex items-center gap-1.5 border-b border-white/40 px-3 py-2">
                            <Search className="h-3 w-3 shrink-0 text-gray-400" />
                            <input
                                autoFocus
                                type="search"
                                aria-label="Search chats"
                                placeholder="Search chats…"
                                value={query}
                                onChange={(event) =>
                                    setQuery(event.target.value)
                                }
                                className="min-w-0 flex-1 bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400"
                            />
                        </div>
                        <div
                            className="max-h-48 overflow-y-auto p-1"
                            role="menu"
                        >
                            {loading ? (
                                <p className="px-2 py-1.5 text-xs text-gray-400">
                                    Loading chats…
                                </p>
                            ) : filteredChats.length === 0 ? (
                                <p className="px-2 py-1.5 text-xs text-gray-400">
                                    {chats.length <= 1
                                        ? "No previous chats."
                                        : "No matches."}
                                </p>
                            ) : (
                                filteredChats.map((chat) => {
                                    const elapsed = formatElapsedTime(
                                        chat.created_at,
                                        now,
                                    );
                                    const createdLabel =
                                        elapsed && chat.created_at
                                            ? `Created ${new Date(chat.created_at).toLocaleString()}`
                                            : undefined;
                                    return (
                                        <LiquidDropdownButton
                                            key={chat.id}
                                            role="menuitem"
                                            onClick={() => loadChat(chat.id)}
                                            className="flex w-full min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left"
                                        >
                                            <span className="min-w-0 flex-1 truncate">
                                                {chat.title ?? "New Chat"}
                                            </span>
                                            {elapsed && (
                                                <time
                                                    dateTime={chat.created_at}
                                                    title={createdLabel}
                                                    aria-label={createdLabel}
                                                    className="shrink-0 text-xs tabular-nums text-muted-foreground"
                                                >
                                                    {elapsed}
                                                </time>
                                            )}
                                        </LiquidDropdownButton>
                                    );
                                })
                            )}
                        </div>
                    </LiquidDropdownSurface>
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
