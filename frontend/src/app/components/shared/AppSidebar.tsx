"use client";

import {
    useState,
    useEffect,
    useMemo,
    useCallback,
    useRef,
    type UIEvent,
} from "react";
import {
  PanelLeft,
  ChevronsUpDown,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { MikeIcon } from "@/shared/ui/MikeIconUI";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { SidebarProjectItem } from "@/app/components/shared/SidebarProjectItem";
import {
    ChatSkeuoIcon,
    IdeSkeuoIcon,
    FolderSkeuoIcon,
    LibrarySkeuoIcon,
    TabularReviewSkeuoIcon,
    WorkflowSkeuoIcon,
    OrganizationSkeuoIcon,
    SettingsSkeuoIcon,
    SignOutSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { HistorySkeuoIcon } from "@/app/components/shared/HistorySkeuoIcon";
import { listProjectSummaries } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import type { Project } from "@/app/components/shared/types";
import { cn } from "@/app/lib/utils";
import { useAssistantHistoryStatuses } from "@/app/hooks/useAssistantHistoryStatuses";
import {
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";

const NAV_ITEMS = [
    { href: "/assistant", label: "Assistant", icon: ChatSkeuoIcon },
    { href: "/ide", label: "IDE", icon: IdeSkeuoIcon },
    { href: "/projects", label: "Projects", icon: FolderSkeuoIcon },
    { href: "/library", label: "Library", icon: LibrarySkeuoIcon },
    {
        href: "/tabular-reviews",
        label: "Tabular Review",
        icon: TabularReviewSkeuoIcon,
    },
    { href: "/workflows", label: "Workflows", icon: WorkflowSkeuoIcon },
];

const RECENT_PROJECT_PAGE_SIZE = 10;
const RECENT_PROJECT_LIST_HEIGHT_CLASS = "h-44";
// Room for an expanded project's recent chats and reviews.
const RECENT_PROJECT_LIST_EXPANDED_HEIGHT_CLASS = "h-64";
const recentProjectsCache = new Map<
    string,
    { projects: Project[]; hasMore: boolean }
>();

function isNearScrollEnd(element: HTMLDivElement) {
    return (
        element.scrollHeight - element.scrollTop - element.clientHeight <= 32
    );
}

interface AppSidebarProps {
    isOpen: boolean;
    onToggle: () => void;
}

export function AppSidebar({ isOpen, onToggle }: AppSidebarProps) {
    const { user, signOut } = useAuth();
    const { profile } = useUserProfile();
    const { chats, loadingMoreChats, loadMoreChats, setCurrentChatId } =
        useChatHistoryContext();
    const router = useRouter();
    const pathname = usePathname();
    const routeChatId = useMemo(() => {
        if (pathname.startsWith("/assistant/chat/")) {
            return pathname.split("/").pop() ?? null;
        }

        const projectChatMatch = pathname.match(
            /^\/projects\/[^/]+\/assistant\/chat\/([^/]+)/,
        );
        return projectChatMatch?.[1] ?? null;
    }, [pathname]);
    const chatIds = useMemo(
        () => (chats ?? []).map((chat) => chat.id),
        [chats],
    );
    const {
        statuses: assistantHistoryStatuses,
        clearStatus: clearAssistantHistoryStatus,
    } = useAssistantHistoryStatuses({ activeChatId: routeChatId, chatIds });
    // Fade the contents in whenever the sidebar opens, from its own toggle or
    // from a page calling setSidebarOpen, but not when it is already open on
    // first render.
    const [shouldAnimate, setShouldAnimate] = useState(false);
    const [wasOpen, setWasOpen] = useState(isOpen);
    if (isOpen !== wasOpen) {
        setWasOpen(isOpen);
        if (isOpen) setShouldAnimate(true);
    }
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    // The toggle slides out from under the pointer as the sidebar resizes, so
    // its hover background is held off after a click until the pointer next
    // enters or leaves it.
    const [toggleHoverSuppressed, setToggleHoverSuppressed] = useState(false);
    const [projectsCollapsed, setProjectsCollapsed] = useState(false);
    const [historyCollapsed, setHistoryCollapsed] = useState(false);
    const activeProjectId = pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;
    const [expandedProjectIds, setExpandedProjectIds] = useState<
        ReadonlySet<string>
    >(() => new Set(activeProjectId ? [activeProjectId] : []));
    // Opening a project expands its recent items. It never collapses one the
    // user opened, so navigating away keeps their choice.
    const [lastActiveProjectId, setLastActiveProjectId] =
        useState(activeProjectId);
    if (activeProjectId !== lastActiveProjectId) {
        setLastActiveProjectId(activeProjectId);
        if (activeProjectId && !expandedProjectIds.has(activeProjectId)) {
            setExpandedProjectIds(
                (current) => new Set([...current, activeProjectId]),
            );
        }
    }
    const setProjectExpanded = useCallback(
        (projectId: string, expanded: boolean) => {
            setExpandedProjectIds((current) => {
                const next = new Set(current);
                if (expanded) next.add(projectId);
                else next.delete(projectId);
                return next;
            });
        },
        [],
    );
    const userId = user?.id ?? null;
    const [recentProjects, setRecentProjects] = useState<Project[] | null>(
        null,
    );
    const [hasMoreRecentProjects, setHasMoreRecentProjects] = useState(false);
    const [loadingMoreRecentProjects, setLoadingMoreRecentProjects] =
        useState(false);
    const loadingMoreRecentProjectsRef = useRef(false);
    const [recentProjectsAttempt, setRecentProjectsAttempt] = useState(0);
    // "Retry" re-enters the latest paging callback; a callback cannot
    // reference itself.
    const retryLoadMoreRecentProjectsRef = useRef<() => void>(() => {});
    const displayedRecentProjects =
        recentProjects ??
        (userId ? recentProjectsCache.get(userId)?.projects : undefined) ??
        null;

    useEffect(() => {
        if (!userId) {
            setRecentProjects([]);
            setHasMoreRecentProjects(false);
            setLoadingMoreRecentProjects(false);
            loadingMoreRecentProjectsRef.current = false;
            return;
        }

        const cached = recentProjectsCache.get(userId);
        if (cached) {
            setRecentProjects(cached.projects);
            setHasMoreRecentProjects(cached.hasMore);
        } else {
            setRecentProjects(null);
            setHasMoreRecentProjects(false);
        }
        const controller = new AbortController();
        setLoadingMoreRecentProjects(false);
        loadingMoreRecentProjectsRef.current = false;

        listProjectSummaries({
            limit: RECENT_PROJECT_PAGE_SIZE + 1,
            signal: controller.signal,
        })
            .then((projects) => {
                if (controller.signal.aborted) return;
                const next = projects.slice(0, RECENT_PROJECT_PAGE_SIZE);
                const hasMore = projects.length > RECENT_PROJECT_PAGE_SIZE;
                recentProjectsCache.set(userId, { projects: next, hasMore });
                setRecentProjects(next);
                setHasMoreRecentProjects(hasMore);
            })
            .catch((error) => {
                if (controller.signal.aborted) return;
                setRecentProjects([]);
                setHasMoreRecentProjects(false);
                // An empty Projects section reads as "you have no projects",
                // which is the one thing this failure does not mean.
                notifyError(error, {
                    action: "load your recent projects",
                    dedupeKey: "sidebar-recent-projects",
                    onRetry: () =>
                        setRecentProjectsAttempt((attempt) => attempt + 1),
                });
            });

        return () => controller.abort();
    }, [recentProjectsAttempt, userId]);

    const loadMoreRecentProjects = useCallback(async () => {
        if (
            !userId ||
            recentProjects === null ||
            !hasMoreRecentProjects ||
            loadingMoreRecentProjectsRef.current
        ) {
            return;
        }

        loadingMoreRecentProjectsRef.current = true;
        setLoadingMoreRecentProjects(true);
        try {
            const projects = await listProjectSummaries({
                limit: RECENT_PROJECT_PAGE_SIZE + 1,
                offset: recentProjects.length,
            });
            const page = projects.slice(0, RECENT_PROJECT_PAGE_SIZE);
            setRecentProjects((current) => {
                const existing = new Set(
                    (current ?? []).map((project) => project.id),
                );
                const next = [
                    ...(current ?? []),
                    ...page.filter((project) => !existing.has(project.id)),
                ];
                recentProjectsCache.set(userId, {
                    projects: next,
                    hasMore: projects.length > RECENT_PROJECT_PAGE_SIZE,
                });
                return next;
            });
            setHasMoreRecentProjects(
                projects.length > RECENT_PROJECT_PAGE_SIZE,
            );
        } catch (error) {
            // The current page survives; the user is told the next one did
            // not arrive instead of scrolling at a list that stopped growing.
            notifyError(error, {
                action: "load more projects",
                dedupeKey: "sidebar-recent-projects-more",
                onRetry: () => retryLoadMoreRecentProjectsRef.current(),
            });
        } finally {
            loadingMoreRecentProjectsRef.current = false;
            setLoadingMoreRecentProjects(false);
        }
    }, [hasMoreRecentProjects, recentProjects, userId]);

    useEffect(() => {
        retryLoadMoreRecentProjectsRef.current = () =>
            void loadMoreRecentProjects();
    }, [loadMoreRecentProjects]);

    const handleRecentProjectsScroll = useCallback(
        (event: UIEvent<HTMLDivElement>) => {
            if (isNearScrollEnd(event.currentTarget)) {
                void loadMoreRecentProjects();
            }
        },
        [loadMoreRecentProjects],
    );

    const handleChatHistoryScroll = useCallback(
        (event: UIEvent<HTMLDivElement>) => {
            if (isNearScrollEnd(event.currentTarget)) {
                void loadMoreChats();
            }
        },
        [loadMoreChats],
    );

    const handleToggle = () => {
        onToggle();
    };

    // A failed sign-out leaves the session live, which the user must know
    // about — on a shared machine especially. Signing out again is safe, so
    // the toast carries a real Retry.
    function handleSignOut() {
        void signOut()
            .then(() => router.push("/"))
            .catch((error) => {
                notifyError(error, {
                    action: "sign out",
                    dedupeKey: "sign-out",
                    onRetry: handleSignOut,
                });
            });
    }

    useEffect(() => {
        setCurrentChatId(routeChatId);
    }, [routeChatId, setCurrentChatId]);

    const getUserInitials = (email: string) => {
        if (profile?.displayName)
            return profile.displayName.charAt(0).toUpperCase();
        return email.charAt(0).toUpperCase();
    };

    const getDisplayName = () => {
        if (!profile) return "";
        return profile.displayName || user?.email?.split("@")[0] || "";
    };

    const anyRecentProjectExpanded =
        displayedRecentProjects?.some((project) =>
            expandedProjectIds.has(project.id),
        ) ?? false;

    if (!user) return null;

    return (
        <>
            {/* Mobile: tapping outside the expanded sidebar closes it. The
                sidebar (z-[99]) sits above this scrim (z-[98]); md+ is
                unaffected since the sidebar is part of the layout there. */}
            {isOpen && (
                <div
                    className="fixed inset-0 z-[98] bg-gray-300/20 md:hidden"
                    onClick={handleToggle}
                    aria-hidden="true"
                />
            )}
            <div
                className={cn(
                    isOpen
                        ? "w-64 h-[calc(100dvh-1rem)] md:h-[calc(100dvh-1.5rem)]"
                        : "max-md:hidden w-[46px] md:h-[calc(100dvh-1.5rem)] h-auto pointer-events-none md:pointer-events-auto",
                    // Collapsed, the ends are full semicircles. The radii are
                    // lengths, not rounded-full, so the change animates with
                    // the width.
                    isOpen ? "rounded-2xl" : "rounded-[23px]",
                    "my-2 ml-2 mr-0 md:my-3 md:ml-3 md:mr-0 overflow-visible",
                    LIQUID_GLASS_FLOAT_CLASS,
                    "absolute z-[99] flex shrink-0 flex-col transition-all duration-300 md:relative",
                )}
            >
                {/* Toggle + Logo */}
                <div
                    className={`h-11 shrink-0 items-center justify-between px-1.5 ${
                        !isOpen ? "hidden md:flex" : "flex"
                    }`}
                >
                    {isOpen && (
                        <div className="px-1.5">
                            <Link
                                href="/assistant"
                                className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                            >
                                <span className="flex shrink-0 px-px">
                                    <MikeIcon size={18} />
                                </span>
                                <span
                                    className={`text-xl font-light font-serif ${
                                        shouldAnimate ? "sidebar-fade-in" : ""
                                    }`}
                                >
                                    Mike
                                </span>
                            </Link>
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={() => {
                            setToggleHoverSuppressed(true);
                            handleToggle();
                        }}
                        onPointerEnter={() => setToggleHoverSuppressed(false)}
                        onPointerLeave={() => setToggleHoverSuppressed(false)}
                        aria-label={isOpen ? "Close sidebar" : "Open sidebar"}
                        className={cn(
                            "group flex h-8 w-8 shrink-0 items-center justify-center transition-[border-radius] duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40",
                            isOpen ? "rounded-md" : "rounded-[16px]",
                            !toggleHoverSuppressed && LIQUID_GLASS_HOVER_CLASS,
                        )}
                        title={isOpen ? "Close sidebar" : "Open sidebar"}
                    >
                        {isOpen ? (
                            <PanelLeft aria-hidden="true" className="h-4 w-4 shrink-0" />
                        ) : (
                            <span aria-hidden="true" className="relative flex h-[18px] w-[18px] items-center justify-center">
                                <span className="absolute inset-0 flex items-center justify-center group-hover:invisible group-focus-visible:invisible">
                                    <MikeIcon size={18} />
                                </span>
                                <PanelLeft className="invisible h-4 w-4 shrink-0 group-hover:visible group-focus-visible:visible" />
                            </span>
                        )}
                    </button>
                </div>

                {/* Nav items */}
                <div className="pt-1.5">
                    {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                        const isActive =
                            href === "/assistant"
                                ? pathname === href
                                : href === "/projects"
                                  ? pathname === href
                                  : pathname === href ||
                                    pathname.startsWith(href + "/");
                        return (
                            <div key={href} className="px-1.5 py-0.5">
                                <button
                                    onClick={() => router.push(href)}
                                    title={!isOpen ? label : ""}
                                    className={cn(
                                        "w-full h-8 flex items-center gap-2 px-2 py-2 rounded-md transition-colors text-left",
                                        isActive
                                            ? `${LIQUID_GLASS_SELECTED_CLASS} text-gray-900`
                                            : `text-gray-700 ${LIQUID_GLASS_HOVER_CLASS}`,
                                        !isOpen ? "hidden md:flex" : "flex",
                                    )}
                                >
                                    <Icon
                                        className={`h-4 w-4 flex-shrink-0 ${
                                            isActive
                                                ? "text-gray-900"
                                                : "text-black"
                                        }`}
                                    />
                                    {isOpen && (
                                        <span
                                            className={`text-sm font-medium ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            {label}
                                        </span>
                                    )}
                                </button>
                            </div>
                        );
                    })}
                </div>

                {isOpen && (
                    <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
                        {/* Recent Projects */}
                        <div>
                            <button
                                onClick={() => setProjectsCollapsed((v) => !v)}
                                className={`mb-2 flex w-full items-center justify-between rounded-md px-3.5 text-xs font-semibold text-gray-500 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 ${
                                    shouldAnimate ? "sidebar-fade-in" : ""
                                }`}
                            >
                                <span>Recent Projects</span>
                                <ChevronDown
                                    className={`h-3.5 w-3.5 transition-transform ${
                                        projectsCollapsed ? "-rotate-90" : ""
                                    }`}
                                />
                            </button>
                            {!projectsCollapsed && (
                                <div
                                    className={cn(
                                        anyRecentProjectExpanded
                                            ? RECENT_PROJECT_LIST_EXPANDED_HEIGHT_CLASS
                                            : RECENT_PROJECT_LIST_HEIGHT_CLASS,
                                        "overflow-y-auto transition-[height] duration-200 motion-reduce:transition-none",
                                    )}
                                    onScroll={handleRecentProjectsScroll}
                                >
                                    {!displayedRecentProjects ? (
                                        <div className="space-y-1 px-1.5">
                                            {[50, 65, 45].map((w, i) => (
                                                <div
                                                    key={i}
                                                    className="flex h-8 items-center gap-2 rounded-md px-2"
                                                >
                                                    <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                                                        <div className="h-3.5 w-3.5 rounded bg-gray-200 animate-pulse" />
                                                    </div>
                                                    <div
                                                        className="h-3 bg-gray-200 rounded animate-pulse"
                                                        style={{
                                                            width: `${w}%`,
                                                        }}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    ) : displayedRecentProjects.length === 0 ? (
                                        <div
                                            className={`px-4.5 py-2 text-xs text-gray-500 ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            No projects yet
                                        </div>
                                    ) : (
                                        <div
                                            className={`space-y-1 px-1.5 pb-1 ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            {displayedRecentProjects.map(
                                                (project) => (
                                                    <SidebarProjectItem
                                                        key={project.id}
                                                        project={project}
                                                        pathname={pathname}
                                                        expanded={expandedProjectIds.has(
                                                            project.id,
                                                        )}
                                                        onExpandedChange={(
                                                            expanded,
                                                        ) =>
                                                            setProjectExpanded(
                                                                project.id,
                                                                expanded,
                                                            )
                                                        }
                                                        onOpenProject={() =>
                                                            router.push(
                                                                `/projects/${project.id}`,
                                                            )
                                                        }
                                                    />
                                                ),
                                            )}
                                            {loadingMoreRecentProjects && (
                                                <div className="flex h-8 items-center justify-center">
                                                    <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Assistant History */}
                        <div
                            className={cn(
                                "flex min-h-0 flex-col",
                                !historyCollapsed && "flex-1",
                            )}
                        >
                            <button
                                onClick={() => setHistoryCollapsed((v) => !v)}
                                className={`mb-2 flex w-full items-center justify-between rounded-md px-3.5 text-xs font-semibold text-gray-500 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 ${
                                    shouldAnimate ? "sidebar-fade-in" : ""
                                }`}
                            >
                                <span>Assistant History</span>
                                <ChevronDown
                                    className={`h-3.5 w-3.5 transition-transform ${
                                        historyCollapsed ? "-rotate-90" : ""
                                    }`}
                                />
                            </button>
                            <div
                                className={cn(
                                    "min-h-0 flex-1 overflow-y-auto",
                                    historyCollapsed && "hidden",
                                )}
                                onScroll={handleChatHistoryScroll}
                            >
                                {!chats ? (
                                    <div className="space-y-1.5 px-1.5">
                                        {[40, 60, 50, 70, 45].map((w, i) => (
                                            <div
                                                key={i}
                                                className="flex h-8 items-center gap-2 rounded-md px-2"
                                            >
                                                <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                                                    <div className="h-3.5 w-3.5 rounded bg-gray-200 animate-pulse" />
                                                </div>
                                                <div
                                                    className="h-3 bg-gray-200 rounded animate-pulse"
                                                    style={{ width: `${w}%` }}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                ) : chats.length === 0 ? (
                                    <div
                                        className={`text-xs text-gray-500 py-2 px-3.5 ${
                                            shouldAnimate
                                                ? "sidebar-fade-in-2"
                                                : ""
                                        }`}
                                    >
                                        No chats yet
                                    </div>
                                ) : (
                                    <>
                                        <div
                                            className={`space-y-1.5 px-1.5 ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            {chats.map((chat) => (
                                                <SidebarChatItem
                                                    key={chat.id}
                                                    chat={chat}
                                                    isActive={
                                                        routeChatId === chat.id
                                                    }
                                                    projectName={
                                                        chat.project_name ??
                                                        undefined
                                                    }
                                                    responseStatus={
                                                        assistantHistoryStatuses[
                                                            chat.id
                                                        ]
                                                    }
                                                    onSelect={() => {
                                                        clearAssistantHistoryStatus(
                                                            chat.id,
                                                        );
                                                        setCurrentChatId(
                                                            chat.id,
                                                        );
                                                        router.push(
                                                            chat.project_id
                                                                ? `/projects/${chat.project_id}/assistant/chat/${chat.id}`
                                                                : `/assistant/chat/${chat.id}`,
                                                        );
                                                    }}
                                                />
                                            ))}
                                        </div>
                                        {loadingMoreChats && (
                                            <div className="flex h-8 items-center justify-center">
                                                <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* User Profile */}
                <div className="mt-auto p-1">
                    {user && (
                        <Dropdown
                            open={isDropdownOpen}
                            onOpenChange={setIsDropdownOpen}
                        >
                          <DropdownTrigger asChild>
                            <button
                                type="button"
                                aria-label="Account menu"
                                className={cn(
                                    "flex h-9 w-full shrink-0 items-center px-1.5 outline-none [transition:border-radius_300ms_cubic-bezier(0.4,0,0.2,1),background-color_150ms,color_150ms] focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                                    isOpen ? "rounded-xl" : "rounded-[18px]",
                                    !isOpen ? "hidden md:flex" : "",
                                    pathname.startsWith("/settings") ||
                                        pathname === "/history" ||
                                        isDropdownOpen
                                        ? LIQUID_GLASS_SELECTED_CLASS
                                        : LIQUID_GLASS_HOVER_CLASS,
                                )}
                                title={!isOpen ? user.email : undefined}
                            >
                                <div className="h-6 w-6 flex-shrink-0 rounded-full bg-gray-700 flex items-center justify-center text-white text-sm font-medium font-serif">
                                    {getUserInitials(user.email)}
                                </div>
                                {isOpen && (
                                    <div
                                        className={`text-left flex-1 min-w-0 pl-2 flex items-center justify-between gap-2 ${
                                            shouldAnimate
                                                ? "sidebar-fade-in-2"
                                                : ""
                                        }`}
                                    >
                                        <span className="min-w-0 break-words text-sm font-medium text-gray-900 leading-tight">
                                            {getDisplayName()}
                                        </span>
                                        <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
                                    </div>
                                )}
                            </button>
                          </DropdownTrigger>
                          <DropdownContent
                              side="top"
                              align="start"
                              className={cn(
                                  "whitespace-nowrap",
                                  isOpen
                                      ? "w-[var(--radix-dropdown-menu-trigger-width)]"
                                      : "w-56",
                              )}
                          >
                              <DropdownItem
                                  selected={pathname === "/history"}
                                  onSelect={() => router.push("/history")}
                                  className="h-8 gap-2 rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:text-gray-700 focus:text-gray-700 data-[selected=true]:text-gray-900 data-[selected=true]:hover:text-gray-900 data-[selected=true]:focus:text-gray-900"
                              >
                                  <HistorySkeuoIcon className={cn("h-4 w-4", pathname === "/history" ? "text-gray-900" : "text-black")} />
                                  History
                              </DropdownItem>
                              <DropdownItem
                                  onSelect={() => router.push("/settings")}
                                  className="h-8 gap-2 rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:text-gray-700 focus:text-gray-700 data-[selected=true]:text-gray-900 data-[selected=true]:hover:text-gray-900 data-[selected=true]:focus:text-gray-900"
                              >
                                  <SettingsSkeuoIcon className="h-4 w-4 text-black" />
                                  Settings
                              </DropdownItem>
                              <DropdownItem
                                  onSelect={() => router.push("/organizations")}
                                  className="h-8 gap-2 rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:text-gray-700 focus:text-gray-700 data-[selected=true]:text-gray-900 data-[selected=true]:hover:text-gray-900 data-[selected=true]:focus:text-gray-900"
                              >
                                  <OrganizationSkeuoIcon className="h-4 w-4 text-black" />
                                  Organizations
                              </DropdownItem>
                              <DropdownItem
                                  onSelect={() => {
                                      void handleSignOut();
                                  }}
                                  className="h-8 gap-2 rounded-md px-2 py-2 text-sm font-medium text-gray-700 hover:text-gray-700 focus:text-gray-700 data-[selected=true]:text-gray-900 data-[selected=true]:hover:text-gray-900 data-[selected=true]:focus:text-gray-900"
                              >
                                  <SignOutSkeuoIcon className="h-4 w-4 text-black" />
                                  Sign out
                              </DropdownItem>
                          </DropdownContent>
                        </Dropdown>
                    )}
                </div>
            </div>
        </>
    );
}
