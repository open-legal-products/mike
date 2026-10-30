"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import {
    DROPDOWN_ROWS_CLASS,
    DropdownButton,
    DropdownSurface,
} from "@/shared/ui/dropdown";
import {
    searchSettings,
    type SettingsSearchEntry,
    type SettingsSearchMatchKind,
    type SettingsSearchResult,
} from "@/app/lib/settingsSearch";

const GROUP_LABEL: Record<SettingsSearchMatchKind, string> = {
    exact: "Matches",
    related: "Related",
};

/** How long to keep looking for a section heading after navigating to it. */
const SECTION_FOCUS_ATTEMPTS = 30;
const SECTION_FOCUS_INTERVAL_MS = 100;

/**
 * Brings the section a result points at into view once its page has drawn
 * it. Pages load their data after mounting, so the heading may not exist at
 * navigation time; the browser's own hash scroll then does nothing. Returns
 * the interval so the caller can stop it if it goes away first.
 */
function focusSection(hash: string): number | null {
    const id = hash.replace(/^#/, "");
    if (!id) return null;
    let attempts = 0;
    const timer = window.setInterval(() => {
        attempts += 1;
        const target = document.getElementById(id);
        if (!target) {
            if (attempts >= SECTION_FOCUS_ATTEMPTS) window.clearInterval(timer);
            return;
        }
        window.clearInterval(timer);
        target.scrollIntoView({ block: "start", behavior: "smooth" });
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
    }, SECTION_FOCUS_INTERVAL_MS);
    return timer;
}

/**
 * A search box over a person's settings. Typing lists the sections and
 * controls that match by name first and by meaning after; choosing one opens
 * its page and scrolls to it.
 */
export function SettingsSearch({
    entries,
}: {
    entries: readonly SettingsSearchEntry[];
}) {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    const list = useRef<HTMLDivElement>(null);
    // The poll for a chosen section's heading; stopped if the search box goes
    // away before the heading appears, so nothing runs against a gone page.
    const sectionTimer = useRef<number | null>(null);
    const listId = useId();
    const results = useMemo(
        () => searchSettings(query, entries),
        [query, entries],
    );
    const showResults = open && query.trim().length > 0;

    useEffect(
        () => () => {
            if (sectionTimer.current !== null)
                window.clearInterval(sectionTimer.current);
        },
        [],
    );

    function choose(result: SettingsSearchResult) {
        setQuery("");
        setOpen(false);
        router.push(result.entry.href);
        const hash = result.entry.href.split("#")[1];
        if (sectionTimer.current !== null)
            window.clearInterval(sectionTimer.current);
        sectionTimer.current = hash ? focusSection(`#${hash}`) : null;
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

    return (
        <div
            className="relative"
            onFocus={() => setOpen(true)}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setOpen(false);
            }}
        >
            <SearchBar
                ref={input}
                size="sm"
                value={query}
                onValueChange={(value) => {
                    setQuery(value);
                    setOpen(true);
                }}
                label="Search settings"
                placeholder="Search settings"
                maxLength={200}
                autoComplete="off"
                aria-controls={showResults ? listId : undefined}
                aria-expanded={showResults}
                onKeyDown={(event) => {
                    if (event.key === "Escape" && query) {
                        event.preventDefault();
                        setQuery("");
                    } else if (event.key === "ArrowDown" && showResults) {
                        event.preventDefault();
                        focusResult("first");
                    } else if (event.key === "Enter" && results[0]) {
                        event.preventDefault();
                        choose(results[0]);
                    }
                }}
            />
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
                    // Anchored to the box's right edge: the box sits at the
                    // right end of the title row, so the list grows leftward
                    // and never runs past the page gutter.
                    className="absolute right-0 top-full mt-2 w-[22rem] max-w-[calc(100vw-3rem)] p-1"
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
                            groups.map((group, groupIndex) => (
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
                                    {group.results.map((result, index) => {
                                        const first = groupIndex === 0 && index === 0;
                                        return (
                                            <DropdownButton
                                                key={result.entry.id}
                                                data-settings-result
                                                // The visible spans run together
                                                // without this; read as a sentence.
                                                aria-label={`${result.entry.title}${
                                                    result.entry.tab !== result.entry.title
                                                        ? `, ${result.entry.tab}`
                                                        : ""
                                                }. ${result.entry.description}`}
                                                className="flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left"
                                                onClick={() => choose(result)}
                                            >
                                                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                                                    <span className="block text-gray-800">
                                                        {result.entry.title}
                                                        {result.entry.title !==
                                                        result.entry.tab ? (
                                                            <span className="text-gray-500">
                                                                {" "}
                                                                · {result.entry.tab}
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                    <span className="block text-gray-500">
                                                        {result.entry.description}
                                                    </span>
                                                </span>
                                                {first ? (
                                                    <CornerDownLeft
                                                        aria-hidden
                                                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400"
                                                    />
                                                ) : null}
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
