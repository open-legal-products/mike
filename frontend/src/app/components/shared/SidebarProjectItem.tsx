"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronRight, CornerDownRight } from "lucide-react";
import {
    ChatSkeuoIcon,
    TabularReviewSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import type {
    Chat,
    Project,
    TabularReview,
} from "@/app/components/shared/types";
import { listProjectChats, listTabularReviews } from "@/app/lib/mikeApi";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
} from "@/app/components/ui/liquid-surface";

/** How many more of a project's chats and reviews each "See more" shows. */
export const PROJECT_RECENT_ITEM_PAGE_SIZE = 5;

/** Tabular reviews fetched per request. */
const REVIEW_PAGE_SIZE = 10;

export type ProjectRecentItem = {
    kind: "chat" | "review";
    id: string;
    title: string;
    href: string;
    /** ISO timestamp of the item's latest activity. */
    activityAt: string;
};

/**
 * Merges a project's assistant chats and tabular reviews into one list,
 * newest activity first.
 */
export function mergeProjectRecentItems(
    projectId: string,
    chats: Chat[],
    reviews: TabularReview[],
): ProjectRecentItem[] {
    return [
        ...chats.map(
            (chat): ProjectRecentItem => ({
                kind: "chat",
                id: chat.id,
                title: chat.title?.trim() || "Untitled chat",
                href: `/projects/${projectId}/assistant/chat/${chat.id}`,
                activityAt: chat.updated_at ?? chat.created_at,
            }),
        ),
        ...reviews.map(
            (review): ProjectRecentItem => ({
                kind: "review",
                id: review.id,
                title: review.title?.trim() || "Untitled review",
                href: `/projects/${projectId}/tabular-reviews/${review.id}`,
                activityAt: review.updated_at ?? review.created_at,
            }),
        ),
    ].sort(
        (a, b) => Date.parse(b.activityAt) - Date.parse(a.activityAt),
    );
}

type ProjectItemsData = {
    chats: Chat[];
    reviews: TabularReview[];
    hasMoreReviews: boolean;
    /** One of the two requests failed; the other list is still shown. */
    incomplete: boolean;
};

// Survives the sidebar remounting, so reopening a project shows its last
// list immediately while it refreshes.
const projectItemsCache = new Map<string, ProjectItemsData>();

// The project chat endpoint returns every chat; reviews come in pages. The
// review overview can sort by creation, not by last update, so the merge
// orders whatever has loaded by activity.
async function fetchReviewPage(
    projectId: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
) {
    const page = await listTabularReviews(projectId, {
        offset,
        limit: limit + 1,
        sortKey: "created",
        sortDirection: "desc",
        signal,
    });
    return { reviews: page.slice(0, limit), hasMore: page.length > limit };
}

async function loadProjectItems(
    projectId: string,
    reviewCount: number,
    signal: AbortSignal,
): Promise<ProjectItemsData> {
    const [chats, reviews] = await Promise.allSettled([
        listProjectChats(projectId),
        // A refresh keeps however many reviews "See more" had already loaded.
        fetchReviewPage(projectId, 0, Math.max(REVIEW_PAGE_SIZE, reviewCount), signal),
    ]);
    if (chats.status === "rejected" && reviews.status === "rejected") {
        throw chats.reason;
    }
    return {
        chats: chats.status === "fulfilled" ? chats.value : [],
        reviews: reviews.status === "fulfilled" ? reviews.value.reviews : [],
        hasMoreReviews:
            reviews.status === "fulfilled" && reviews.value.hasMore,
        incomplete:
            chats.status === "rejected" || reviews.status === "rejected",
    };
}

interface Props {
    project: Project;
    pathname: string;
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
    onOpenProject: () => void;
}

export function SidebarProjectItem({
    project,
    pathname,
    expanded,
    onExpandedChange,
    onOpenProject,
}: Props) {
    const projectPath = `/projects/${project.id}`;
    const isActive =
        pathname === projectPath || pathname.startsWith(`${projectPath}/`);
    const [data, setData] = useState<ProjectItemsData | null>(
        () => projectItemsCache.get(project.id) ?? null,
    );
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [visibleCount, setVisibleCount] = useState(
        PROJECT_RECENT_ITEM_PAGE_SIZE,
    );
    const [loadingMore, setLoadingMore] = useState(false);
    const reviewCountRef = useRef(data?.reviews.length ?? 0);
    reviewCountRef.current = data?.reviews.length ?? 0;
    // Navigating inside the active project (a new chat, a new review)
    // refreshes its list; other projects keep what they loaded.
    const refreshKey = isActive ? pathname : "";

    useEffect(() => {
        if (!expanded) return;
        const controller = new AbortController();
        loadProjectItems(project.id, reviewCountRef.current, controller.signal)
            .then((next) => {
                if (controller.signal.aborted) return;
                projectItemsCache.set(project.id, next);
                setData(next);
                setLoadError(false);
            })
            .catch(() => {
                if (!controller.signal.aborted) setLoadError(true);
            });
        return () => controller.abort();
    }, [expanded, project.id, refreshKey, reloadKey]);

    const items = data
        ? mergeProjectRecentItems(project.id, data.chats, data.reviews)
        : null;
    const visibleItems = items?.slice(0, visibleCount) ?? [];
    const canSeeMore =
        !!items && (items.length > visibleCount || !!data?.hasMoreReviews);

    const seeMore = async () => {
        if (!data || loadingMore) return;
        const nextCount = visibleCount + PROJECT_RECENT_ITEM_PAGE_SIZE;
        if (data.hasMoreReviews) {
            setLoadingMore(true);
            // The page's offset comes from this list. If a refresh has
            // replaced it by the time the page lands (or had already landed
            // but not yet re-rendered when this click ran), the offsets no
            // longer line up, so the page is dropped. The refreshed list
            // keeps its own hasMoreReviews and the next click fetches again.
            const requestedFrom = data;
            try {
                const page = await fetchReviewPage(
                    project.id,
                    data.reviews.length,
                    REVIEW_PAGE_SIZE,
                );
                setData((current) => {
                    if (!current || current !== requestedFrom) return current;
                    const seen = new Set(
                        current.reviews.map((review) => review.id),
                    );
                    const next = {
                        ...current,
                        reviews: [
                            ...current.reviews,
                            ...page.reviews.filter(
                                (review) => !seen.has(review.id),
                            ),
                        ],
                        hasMoreReviews: page.hasMore,
                    };
                    projectItemsCache.set(project.id, next);
                    return next;
                });
            } catch {
                // Show what has loaded; the next "See more" retries.
            } finally {
                setLoadingMore(false);
            }
        }
        setVisibleCount(nextCount);
    };

    const retryRow = (message: string) => (
        <li className="flex min-h-7 flex-wrap items-center gap-x-2 pl-2 pr-2 text-xs text-gray-500">
            <span role="alert">{message}</span>
            <button
                type="button"
                onClick={() => {
                    setLoadError(false);
                    setReloadKey((key) => key + 1);
                }}
                className="font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
                Retry
            </button>
        </li>
    );

    const listId = `sidebar-project-items-${project.id}`;
    // Sub-rows are not indented: they share the project row's pl-2, 16px
    // icon box and gap-2. A curved arrow fills the box under the folder
    // icon, so each item's own icon starts where the project name does.
    const subRowArrow = (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
            <CornerDownRight
                aria-hidden="true"
                className="h-3.5 w-3.5 text-gray-400"
            />
        </span>
    );

    return (
        <div>
            <div
                className={cn(
                    "group flex h-8 w-full items-center rounded-md pr-1 text-xs transition-colors",
                    isActive
                        ? `${LIQUID_GLASS_SELECTED_CLASS} text-gray-900`
                        : `text-gray-700 ${LIQUID_GLASS_HOVER_CLASS}`,
                )}
            >
                <button
                    type="button"
                    onClick={onOpenProject}
                    title={project.name}
                    // The row owns the hover fill, so it draws the ring.
                    data-focus-fill
                    className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md py-1 pl-2 text-left outline-none"
                >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                        <ProjectSvgIcon
                            open={isActive}
                            className="h-3.5 w-3.5"
                        />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                        {project.name}
                    </span>
                </button>
                <button
                    type="button"
                    onClick={() => onExpandedChange(!expanded)}
                    aria-expanded={expanded}
                    aria-controls={expanded ? listId : undefined}
                    aria-label={`${expanded ? "Hide" : "Show"} recent chats and reviews in ${project.name}`}
                    className={cn(
                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-400 transition-opacity hover:text-gray-700 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                        expanded || isActive
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                    )}
                >
                    <ChevronRight
                        className={cn(
                            "h-3.5 w-3.5 transition-transform",
                            expanded && "rotate-90",
                        )}
                    />
                </button>
            </div>

            {expanded && (
                <ul id={listId} className="mt-0.5 space-y-0.5">
                    {data === null && !loadError ? (
                        [60, 45].map((width) => (
                            <li
                                key={width}
                                aria-hidden="true"
                                className="flex h-7 items-center gap-2 pl-2 pr-2"
                            >
                                {subRowArrow}
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                        <span className="h-3.5 w-3.5 animate-pulse rounded bg-gray-200" />
                                    </span>
                                    <span
                                        className="h-2.5 animate-pulse rounded bg-gray-200"
                                        style={{ width: `${width}%` }}
                                    />
                                </span>
                            </li>
                        ))
                    ) : (loadError || data?.incomplete) &&
                      (items === null || items.length === 0) ? (
                        // Nothing to show: a failed load or refresh, or one
                        // request failed and the other came back empty.
                        retryRow(
                            loadError && data !== null
                                ? "Could not refresh items."
                                : "Could not load items.",
                        )
                    ) : items && items.length === 0 ? (
                        <li className="flex min-h-7 items-center pl-2 pr-2 text-xs text-gray-500">
                            No chats or reviews yet
                        </li>
                    ) : (
                        <>
                            {visibleItems.map((item) => {
                                const itemActive =
                                    pathname === item.href ||
                                    pathname.startsWith(`${item.href}/`);
                                const Icon =
                                    item.kind === "chat"
                                        ? ChatSkeuoIcon
                                        : TabularReviewSkeuoIcon;
                                return (
                                    <li key={`${item.kind}-${item.id}`}>
                                        <Link
                                            href={item.href}
                                            title={item.title}
                                            aria-label={`${item.kind === "chat" ? "Chat" : "Tabular review"}: ${item.title}`}
                                            aria-current={
                                                itemActive ? "page" : undefined
                                            }
                                            className={cn(
                                                "flex h-7 w-full items-center gap-2 rounded-md pl-2 pr-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40",
                                                itemActive
                                                    ? `${LIQUID_GLASS_SELECTED_CLASS} text-gray-900`
                                                    : `text-gray-600 ${LIQUID_GLASS_HOVER_CLASS}`,
                                            )}
                                        >
                                            {subRowArrow}
                                            <span className="flex min-w-0 flex-1 items-center gap-2">
                                                {/* Same icon and size as the
                                                    Assistant History rows. */}
                                                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                                    <Icon className="h-3.5 w-3.5" />
                                                </span>
                                                <span className="min-w-0 flex-1 truncate">
                                                    {item.title}
                                                </span>
                                            </span>
                                        </Link>
                                    </li>
                                );
                            })}
                            {/* A refresh that failed keeps the items it
                                had; a partial load shows what did load. */}
                            {loadError
                                ? retryRow("Could not refresh items.")
                                : data?.incomplete &&
                                  retryRow("Some items could not be loaded.")}
                            {canSeeMore && (
                                <li>
                                    <button
                                        type="button"
                                        onClick={() => void seeMore()}
                                        disabled={loadingMore}
                                        aria-controls={listId}
                                        className="flex h-7 w-full items-center rounded-md pl-2 pr-2 text-left text-xs text-gray-500 transition-colors hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 disabled:cursor-default"
                                    >
                                        {loadingMore ? "Loading..." : "See more"}
                                    </button>
                                </li>
                            )}
                        </>
                    )}
                </ul>
            )}
        </div>
    );
}
