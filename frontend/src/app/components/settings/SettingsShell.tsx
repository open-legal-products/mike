"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { usePathname, useRouter } from "next/navigation";
import { settingsTabButtonClassName } from "@/app/(pages)/settings/settingsStyles";

export interface SettingsShellTab {
    id: string;
    label: string;
    href: string;
    badge?: ReactNode;
}

/**
 * A run of sections listed together. `label` names the run: above it down
 * the side, before it across the top. An area whose sections need no
 * grouping passes one run without a label.
 */
export interface SettingsShellGroup {
    id: string;
    label?: string;
    tabs: SettingsShellTab[];
}

/**
 * The frame every settings area shares: a serif title, the sections down the
 * side (across the top when the page is narrow) and the open section beside
 * them. A person's settings and an organization's use the same one, so the
 * two read as the same kind of place.
 *
 * `rootHref` is the area's first section, whose path is a prefix of every
 * other's: it is the open one only on an exact match.
 */
export function SettingsShell({
    title,
    navLabel,
    groups,
    rootHref,
    search,
    children,
}: {
    title: ReactNode;
    /** The navigation's accessible name. */
    navLabel: string;
    groups: SettingsShellGroup[];
    rootHref: string;
    /** A search box drawn at the right end of the title row, when the area has one. */
    search?: ReactNode;
    children: ReactNode;
}) {
    const pathname = usePathname();
    const scrollerRef = useRef<HTMLDivElement>(null);
    const activeTabRef = useRef<HTMLButtonElement>(null);

    // Across the top of a narrow page the sections scroll sideways, and the
    // open one can start out of view. Bring it in, with its group's label
    // where that fits, by scrolling that row only: the page's own scroll
    // belongs to the open section (Settings search scrolls to a heading).
    // Down the side nothing overflows sideways, so nothing moves.
    useEffect(() => {
        const scroller = scrollerRef.current;
        const tab = activeTabRef.current;
        if (!scroller || !tab) return;
        const row = scroller.getBoundingClientRect();
        const open = tab.getBoundingClientRect();
        if (open.left >= row.left && open.right <= row.right) return;
        const group = tab.closest("[data-settings-nav-group]");
        const groupLeft = group?.getBoundingClientRect().left ?? open.left;
        const start =
            open.right - groupLeft <= row.width ? groupLeft : open.left;
        scroller.scrollLeft += start - row.left;
    }, [pathname]);

    const isActive = (tab: SettingsShellTab) =>
        pathname === tab.href ||
        (tab.href !== rootHref && pathname.startsWith(tab.href));

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <header className="mx-auto flex h-16 w-full max-w-5xl shrink-0 items-end justify-between gap-4 px-6 pb-2 md:h-24 md:pb-4">
                <h1 className="shrink-0 text-3xl font-medium font-eb-garamond">
                    {title}
                </h1>
                {/* The search sits at the right end of the heading's row, so the
                    sections and the open page keep their places. */}
                {search ? (
                    <div className="relative z-20 w-full min-w-0 max-w-[18rem]">
                        {search}
                    </div>
                ) : null}
            </header>

            <main className="@container/settings mx-auto w-full max-w-5xl flex-1 px-6 pb-10 pt-4 md:pt-6">
                <div className="grid grid-cols-1 gap-y-6 @min-[52rem]/settings:grid-cols-[224px_minmax(0,1fr)] @min-[52rem]/settings:gap-x-10">
                    <nav
                        aria-label={navLabel}
                        className="z-10 -ml-3 min-w-0 self-start @min-[52rem]/settings:sticky @min-[52rem]/settings:top-4"
                    >
                        <div className="-m-1 min-w-0 p-1">
                            <div
                                ref={scrollerRef}
                                className="-m-1 min-w-0 overflow-x-auto overflow-y-hidden p-1"
                            >
                                <div className="flex gap-4 @min-[52rem]/settings:flex-col @min-[52rem]/settings:gap-6">
                                    {groups.map((group) => (
                                        <SettingsNavGroup
                                            key={group.id}
                                            group={group}
                                            isActive={isActive}
                                            activeTabRef={activeTabRef}
                                        />
                                    ))}
                                </div>
                            </div>
                        </div>
                    </nav>

                    <div className="min-w-0 outline-none">{children}</div>
                </div>
            </main>
        </div>
    );
}

/** One run of sections, named by its label when it has one. */
function SettingsNavGroup({
    group,
    isActive,
    activeTabRef,
}: {
    group: SettingsShellGroup;
    isActive: (tab: SettingsShellTab) => boolean;
    activeTabRef: RefObject<HTMLButtonElement | null>;
}) {
    const router = useRouter();
    const labelId = useId();

    return (
        <div
            data-settings-nav-group
            className="flex shrink-0 items-center gap-1 @min-[52rem]/settings:flex-col @min-[52rem]/settings:items-stretch"
        >
            {group.label ? (
                <p
                    id={labelId}
                    className="mb-0 shrink-0 px-3 text-xs font-semibold whitespace-nowrap text-gray-500 @min-[52rem]/settings:pb-1"
                >
                    {group.label}
                </p>
            ) : null}
            <ul
                aria-labelledby={group.label ? labelId : undefined}
                className="mb-0 flex gap-1 @min-[52rem]/settings:flex-col"
            >
                {group.tabs.map((tab) => {
                    const active = isActive(tab);
                    return (
                        <li key={tab.id}>
                            <button
                                ref={active ? activeTabRef : undefined}
                                type="button"
                                aria-current={active ? "page" : undefined}
                                onClick={() => router.push(tab.href)}
                                className={settingsTabButtonClassName(active)}
                            >
                                {tab.label}
                                {tab.badge ? <> {tab.badge}</> : null}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
