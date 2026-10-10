"use client";

import {
    useEffect,
    useRef,
    type HTMLAttributes,
    type ReactElement,
    type ReactNode,
} from "react";
import { Loader2, Search } from "lucide-react";
import {
    DROPDOWN_ROWS_CLASS,
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "./dropdown";

/** One chat in the history menu. */
export type ChatHistoryDropdownItemUI = {
    id: string;
    title: string;
    /** The chat already on screen. */
    current?: boolean;
    /** Leading mark, such as an answering or finished indicator. */
    icon?: ReactNode;
    /** When the chat was last active, already formatted for the row. */
    time?: {
        label: string;
        dateTime?: string;
        /** The full date, for the tooltip and assistive technology. */
        description?: string;
    };
    /** This row is being opened: it shows a spinner at its trailing edge. */
    pending?: boolean;
};

export interface ChatHistoryDropdownUIProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** The button that opens the menu. It becomes the menu's trigger. */
    trigger: ReactElement;
    /** Already filtered and ordered by the caller. */
    items: ChatHistoryDropdownItemUI[];
    onSelect: (id: string) => void;
    /**
     * False keeps the menu open after a row is chosen, for a caller that has
     * to load the chat first and closes the menu itself once it has.
     */
    closeOnSelect?: boolean;
    /** Rows cannot be chosen, e.g. while another one is being opened. */
    disabled?: boolean;

    query: string;
    onQueryChange: (query: string) => void;
    searchLabel?: string;
    searchPlaceholder?: string;

    loading?: boolean;
    loadingLabel?: string;
    /** The list could not be loaded. Replaces the rows. */
    error?: string | null;
    onRetry?: () => void;
    /** A failure that leaves the rows usable, e.g. one chat failed to open. */
    notice?: string | null;
    /** Shown when there are no rows: nothing saved, or nothing matches. */
    emptyLabel: string;

    /** Called as the list is scrolled to its end, to load the next page. */
    onReachEnd?: () => void;
    loadingMore?: boolean;
    /** A closing line under the rows, e.g. that every chat is loaded. */
    footer?: ReactNode;

    /** Which edge of the trigger the menu lines up with. */
    align?: "start" | "center" | "end";
    /** Extra attributes for the scrolling list, such as a test id. */
    listProps?: HTMLAttributes<HTMLDivElement> & {
        [key: `data-${string}`]: string | undefined;
    };
}

const STATUS_TEXT_CLASS = "px-2 py-1.5 text-xs text-gray-400";
const END_THRESHOLD_PX = 24;

/**
 * The chat history menu: a search field over a scrolling list of chats, with
 * the loading, empty, failed and paginating states a history list needs.
 *
 * Presentational only. The caller owns the chats, the search text and what
 * choosing a chat does, so the web app's chat header and the Word add-in can
 * feed it from different stores and still show the same menu.
 */
export function ChatHistoryDropdownUI({
    open,
    onOpenChange,
    trigger,
    items,
    onSelect,
    closeOnSelect = true,
    disabled = false,
    query,
    onQueryChange,
    searchLabel = "Search chats",
    searchPlaceholder = "Search chats…",
    loading = false,
    loadingLabel = "Loading chats…",
    error,
    onRetry,
    notice,
    emptyLabel,
    onReachEnd,
    loadingMore = false,
    footer,
    align = "start",
    listProps,
}: ChatHistoryDropdownUIProps): ReactElement {
    const searchInputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Typing starts in the search field, not on the menu or its first chat.
    // The menu takes focus as it opens, so this runs just after.
    useEffect(() => {
        if (!open) return;
        const timer = window.setTimeout(
            () => searchInputRef.current?.focus(),
            0,
        );
        return () => window.clearTimeout(timer);
    }, [open]);

    return (
        <Dropdown open={open} onOpenChange={onOpenChange}>
            <DropdownTrigger asChild>{trigger}</DropdownTrigger>
            <DropdownContent
                align={align}
                sideOffset={8}
                // One size everywhere, so the menu is the same menu in the web
                // header and in the Word pane (it fits the narrowest pane).
                className="flex w-64 max-w-[calc(100vw-1.5rem)] flex-col gap-0 overflow-hidden p-0"
            >
                <div className="flex shrink-0 items-center gap-1.5 border-b border-white/40 px-3 py-2">
                    <Search
                        aria-hidden="true"
                        className="h-3 w-3 shrink-0 text-gray-400"
                    />
                    <input
                        ref={searchInputRef}
                        type="search"
                        aria-label={searchLabel}
                        placeholder={searchPlaceholder}
                        data-dropdown-input="flush"
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "ArrowDown") {
                                event.preventDefault();
                                listRef.current
                                    ?.querySelector<HTMLElement>(
                                        '[role="menuitem"]',
                                    )
                                    ?.focus();
                            }
                            // Keep the menu's type-ahead from moving focus
                            // while typing here.
                            if (event.key !== "Escape") event.stopPropagation();
                        }}
                        className="min-w-0 flex-1 bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400"
                    />
                </div>
                <div
                    {...listProps}
                    ref={listRef}
                    className={`max-h-48 min-h-0 overflow-y-auto p-1 ${DROPDOWN_ROWS_CLASS}`}
                    onScroll={(event) => {
                        listProps?.onScroll?.(event);
                        if (!onReachEnd) return;
                        const element = event.currentTarget;
                        if (
                            element.scrollHeight -
                                element.scrollTop -
                                element.clientHeight <=
                            END_THRESHOLD_PX
                        ) {
                            onReachEnd();
                        }
                    }}
                >
                    {notice && (
                        <p role="alert" className="px-2 py-1.5 text-xs text-red-600">
                            {notice}
                        </p>
                    )}
                    {error ? (
                        <div className="flex flex-col items-start gap-1 px-2 py-1.5">
                            <p role="alert" className="text-xs text-red-600">
                                {error}
                            </p>
                            {onRetry && (
                                <button
                                    type="button"
                                    onClick={onRetry}
                                    className="rounded-md text-xs font-medium text-gray-700 underline-offset-2 transition-colors hover:text-gray-950 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                >
                                    Retry
                                </button>
                            )}
                        </div>
                    ) : loading ? (
                        <p role="status" className={STATUS_TEXT_CLASS}>
                            {loadingLabel}
                        </p>
                    ) : items.length === 0 ? (
                        <p className={STATUS_TEXT_CLASS}>{emptyLabel}</p>
                    ) : (
                        <>
                            {items.map((item) => (
                                <DropdownItem
                                    key={item.id}
                                    selected={item.current}
                                    aria-current={
                                        item.current ? "page" : undefined
                                    }
                                    disabled={disabled}
                                    onSelect={(event) => {
                                        if (!closeOnSelect) {
                                            event.preventDefault();
                                        }
                                        onSelect(item.id);
                                    }}
                                    className="min-w-0 px-2"
                                >
                                    {item.icon}
                                    <span className="min-w-0 flex-1 truncate">
                                        {item.title}
                                    </span>
                                    {item.time && (
                                        <time
                                            dateTime={item.time.dateTime}
                                            title={item.time.description}
                                            aria-label={item.time.description}
                                            className="shrink-0 text-xs tabular-nums text-muted-foreground"
                                        >
                                            {item.time.label}
                                        </time>
                                    )}
                                    {item.pending && (
                                        <Loader2
                                            role="status"
                                            aria-label={`Opening ${item.title}`}
                                            className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400 motion-reduce:animate-none"
                                        />
                                    )}
                                </DropdownItem>
                            ))}
                            {loadingMore && (
                                <p role="status" className={STATUS_TEXT_CLASS}>
                                    Loading more chats…
                                </p>
                            )}
                            {footer && (
                                <p className={STATUS_TEXT_CLASS}>{footer}</p>
                            )}
                        </>
                    )}
                </div>
            </DropdownContent>
        </Dropdown>
    );
}
