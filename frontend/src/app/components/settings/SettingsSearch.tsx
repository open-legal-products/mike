"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRight, Search, X } from "lucide-react";
import {
    DROPDOWN_ROWS_CLASS,
    DropdownButton,
    DropdownSurface,
    HeaderButtonUI,
    headerButtonClassName,
} from "@mike/ui";
import { LIQUID_GLASS_SELECTED_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";
import {
    searchSettings,
    type SettingsSearchEntry,
    type SettingsSearchMatchKind,
    type SettingsSearchResult,
} from "@/app/lib/settingsSearch";

/** Characters typed before the results open. */
const MIN_QUERY_LENGTH = 3;

const GROUP_LABEL: Record<SettingsSearchMatchKind, string> = {
    exact: "Matches",
    related: "Related",
};

/**
 * Wait for the chosen section to mount. Route compilation and page data may
 * take arbitrarily longer than a short timer; DOM arrival is the readiness
 * signal. The caller cancels observation on another choice or unmount.
 */
function focusSection(hash: string): (() => void) | null {
    const id = hash.replace(/^#/, "");
    if (!id) return null;
    const observer = new MutationObserver(focusWhenReady);
    function focusWhenReady() {
        const target = document.getElementById(id);
        if (!target) return;
        observer.disconnect();
        target.scrollIntoView({ block: "start", behavior: "smooth" });
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
    }
    observer.observe(document.body, { childList: true, subtree: true });
    focusWhenReady();
    return () => observer.disconnect();
}

/**
 * A search over a person's settings, as a page-header search button: it
 * opens into a box, and typing lists the sections and controls that match by
 * name first and by meaning after; choosing one opens its page and scrolls to
 * it. Left empty, the box folds back into the button.
 */
export function SettingsSearch({
    entries,
    label = "Search settings",
}: {
    entries: readonly SettingsSearchEntry[];
    /** The button's and box's name, and the box's placeholder. */
    label?: string;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    // Whether the button has opened into a box; it stays open while it holds
    // a query.
    const [expanded, setExpanded] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const refocusButton = useRef(false);
    const list = useRef<HTMLDivElement>(null);
    // One pending section observation, scoped to this mounted search box.
    const cancelSectionFocus = useRef<(() => void) | null>(null);
    const sectionPath = useRef<string | null>(null);
    const listId = useId();
    const results = useMemo(
        () => searchSettings(query, entries),
        [query, entries],
    );
    // A word or two in before anything is listed: one or two letters match
    // almost everything.
    const showResults = open && query.trim().length >= MIN_QUERY_LENGTH;

    useEffect(
        () => () => {
            cancelSectionFocus.current?.();
        },
        [],
    );

    useEffect(() => {
        if (!expanded && refocusButton.current) {
            refocusButton.current = false;
            button.current?.focus();
        }
    }, [expanded]);

    useEffect(() => {
        if (sectionPath.current && pathname !== sectionPath.current) {
            cancelSectionFocus.current?.();
            cancelSectionFocus.current = null;
            sectionPath.current = null;
        }
    }, [pathname]);

    function choose(result: SettingsSearchResult) {
        setQuery("");
        setOpen(false);
        setExpanded(false);
        router.push(result.entry.href);
        const hash = result.entry.href.split("#")[1];
        cancelSectionFocus.current?.();
        sectionPath.current = hash ? result.entry.href.split("#")[0] : null;
        cancelSectionFocus.current = hash ? focusSection(`#${hash}`) : null;
    }

    function focusResult(position: "first" | "last") {
        const buttons = list.current?.querySelectorAll<HTMLButtonElement>(
            "[data-settings-result]",
        );
        if (!buttons?.length) return;
        buttons[position === "first" ? 0 : buttons.length - 1].focus();
    }

    const groups = (["exact", "related"] as const)
        .map((kind) => ({
            kind,
            results: results.filter((result) => result.kind === kind),
        }))
        .filter((group) => group.results.length > 0);

    if (!expanded && !query)
        return (
            <HeaderButtonUI
                ref={button}
                iconOnly
                title={label}
                aria-label={label}
                onClick={() => setExpanded(true)}
            >
                <Search aria-hidden="true" className="h-4 w-4" />
            </HeaderButtonUI>
        );

    return (
        <div
            className="relative flex items-center"
            onFocus={() => setOpen(true)}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setOpen(false);
                    if (!query) setExpanded(false);
                }
            }}
        >
            <div
                className={cn(
                    headerButtonClassName({
                        className:
                            "cursor-text justify-start gap-2 px-3 text-gray-700 hover:text-gray-700",
                    }),
                    `w-56 sm:w-72 ${LIQUID_GLASS_SELECTED_CLASS}`,
                )}
            >
                <Search
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-gray-400"
                />
                <input
                    ref={input}
                    // Opened from the button: the box takes its focus.
                    autoFocus
                    type="search"
                    aria-label={label}
                    placeholder={label}
                    maxLength={200}
                    autoComplete="off"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setOpen(true);
                    }}
                    aria-controls={showResults ? listId : undefined}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") {
                            event.preventDefault();
                            if (query) setQuery("");
                            else {
                                refocusButton.current = true;
                                setExpanded(false);
                            }
                        } else if (event.key === "ArrowDown" && showResults) {
                            event.preventDefault();
                            focusResult("first");
                        } else if (event.key === "Enter" && results[0]) {
                            event.preventDefault();
                            choose(results[0]);
                        }
                    }}
                    className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400 [&::-webkit-search-cancel-button]:hidden"
                />
                {query ? (
                    <button
                        type="button"
                        onClick={() => {
                            setQuery("");
                            input.current?.focus();
                        }}
                        aria-label="Clear search"
                        className="shrink-0 rounded-full p-0.5 text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                ) : null}
            </div>
            <span role="status" className="sr-only">
                {showResults
                    ? results.length === 1
                        ? "1 setting found"
                        : `${results.length} settings found`
                    : ""}
            </span>
            {showResults ? (
                <DropdownSurface
                    id={listId}
                    // Safari and Firefox do not focus a button on press, so a
                    // pointer in the list would blur the box with no related
                    // target, unmount the list and lose the click. Keeping
                    // focus in the box avoids that; scrollbars still drag.
                    onMouseDown={(event) => event.preventDefault()}
                    // Exactly as wide as the box above it.
                    className="absolute inset-x-0 top-full mt-2 p-1"
                >
                    <div
                        ref={list}
                        role="group"
                        aria-label="Settings search results"
                        className={`max-h-80 overflow-y-auto overscroll-contain ${DROPDOWN_ROWS_CLASS}`}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                event.preventDefault();
                                input.current?.focus();
                                return;
                            }
                            if (
                                !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                                    event.key,
                                )
                            )
                                return;
                            const buttons = [
                                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                                    "[data-settings-result]",
                                ),
                            ];
                            const index = buttons.indexOf(
                                document.activeElement as HTMLButtonElement,
                            );
                            if (index < 0) return;
                            event.preventDefault();
                            if (event.key === "ArrowUp" && index === 0) {
                                input.current?.focus();
                                return;
                            }
                            const next =
                                event.key === "Home"
                                    ? 0
                                    : event.key === "End"
                                      ? buttons.length - 1
                                      : index + (event.key === "ArrowDown" ? 1 : -1);
                            buttons[
                                Math.min(buttons.length - 1, Math.max(0, next))
                            ]?.focus();
                        }}
                    >
                        {groups.length === 0 ? (
                            <p className="px-3 py-4 text-center text-xs text-gray-500">
                                No settings match &ldquo;{query.trim()}&rdquo;.
                            </p>
                        ) : (
                            groups.map((group) => (
                                <div
                                    key={group.kind}
                                    role="group"
                                    aria-label={GROUP_LABEL[group.kind]}
                                    className={DROPDOWN_ROWS_CLASS}
                                >
                                    {groups.length > 1 ? (
                                        <p
                                            aria-hidden
                                            className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400"
                                        >
                                            {GROUP_LABEL[group.kind]}
                                        </p>
                                    ) : null}
                                    {group.results.map((result) => {
                                        const { tab, title } = result.entry;
                                        return (
                                            <DropdownButton
                                                key={result.entry.id}
                                                data-settings-result
                                                // The crumbs run together without
                                                // this; read as "Title, Section".
                                                aria-label={
                                                    title !== tab
                                                        ? `${title}, ${tab}`
                                                        : title
                                                }
                                                className="flex w-full min-w-0 items-center gap-1 rounded-lg px-3 py-2 text-left"
                                                onClick={() => choose(result)}
                                            >
                                                {/* Where it is, breadcrumb style:
                                                    "Security › Multi-Factor
                                                    Authentication". */}
                                                {title !== tab ? (
                                                    <>
                                                        <span className="shrink-0 text-gray-500">
                                                            {tab}
                                                        </span>
                                                        <ChevronRight
                                                            aria-hidden="true"
                                                            className="h-3.5 w-3.5 shrink-0 text-gray-400"
                                                        />
                                                    </>
                                                ) : null}
                                                <span className="min-w-0 truncate text-gray-800">
                                                    {title}
                                                </span>
                                            </DropdownButton>
                                        );
                                    })}
                                </div>
                            ))
                        )}
                    </div>
                </DropdownSurface>
            ) : null}
        </div>
    );
}
