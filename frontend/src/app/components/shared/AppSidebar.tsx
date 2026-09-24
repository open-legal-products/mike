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
import { MikeIcon } from "@/app/components/chat/mike-icon";
import { SidebarChatItem } from "@/app/components/shared/SidebarChatItem";
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
import { ProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";
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
    const [shouldAnimate, setShouldAnimate] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [projectsCollapsed, setProjectsCollapsed] = useState(false);
    const [historyCollapsed, setHistoryCollapsed] = useState(false);
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
        if (isOpen) setShouldAnimate(true);
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
        const handleClickOutside = () => setIsDropdownOpen(false);
        if (isDropdownOpen) {
            document.addEventListener("click", handleClickOutside);
            return () =>
                document.removeEventListener("click", handleClickOutside);
        }
    }, [isDropdownOpen]);

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

    const getUserTier = () => {
        if (!profile) return "";
        return profile.tier || "Free";
    };

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
                        : "max-md:hidden w-[50px] md:h-[calc(100dvh-1.5rem)] h-auto pointer-events-none md:pointer-events-auto",
                    "my-2 ml-2 mr-0 md:my-3 md:ml-3 md:mr-0 rounded-2xl backdrop-blur-2xl overflow-visible",
                    LIQUID_GLASS_FLOAT_CLASS,
                    "absolute z-[99] flex shrink-0 flex-col transition-all duration-300 md:relative",
                )}
            >
                {/* Toggle + Logo */}
                <div
                    className={`h-12 shrink-0 items-center justify-between px-2 ${
                        !isOpen ? "hidden md:flex" : "flex"
                    }`}
                >
                    {isOpen && (
                        <div className="px-1.5">
                            <Link
                                href="/assistant"
                                className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                            >
                                <MikeIcon size={20} />
                                <span
                                    className={`text-[22px] font-light font-serif ${
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
                        onClick={handleToggle}
                        aria-label={isOpen ? "Close sidebar" : "Open sidebar"}
                        className={cn(
                            "flex h-8 w-8 shrink-0 items-center p-2 transition-colors",
                            "rounded-md",
                            LIQUID_GLASS_HOVER_CLASS,
                        )}
                        title={isOpen ? "Close sidebar" : "Open sidebar"}
                    >
                        <PanelLeft className="h-4 w-4 shrink-0" />
                    </button>
                </div>

                {/* Nav items */}
                <div className="pt-2">
                    {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                        const isActive =
                            href === "/assistant"
                                ? pathname === href
                                : href === "/projects"
                                  ? pathname === href
                                  : pathname === href ||
                                    pathname.startsWith(href + "/");
                        return (
                            <div key={href} className="px-2 py-0.5">
                                <button
                                    onClick={() => router.push(href)}
                                    title={!isOpen ? label : ""}
                                    className={cn(
                                        "w-full h-9 flex items-center gap-3 px-2 py-2 rounded-md transition-colors text-left",
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
                                className={`mb-2 flex w-full items-center justify-between px-4 text-xs font-semibold text-gray-500 transition-colors hover:text-gray-700 ${
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
                                        RECENT_PROJECT_LIST_HEIGHT_CLASS,
                                        "overflow-y-auto",
                                    )}
                                    onScroll={handleRecentProjectsScroll}
                                >
                                    {!displayedRecentProjects ? (
                                        <div className="space-y-1 px-2">
                                            {[50, 65, 45].map((w, i) => (
                                                <div
                                                    key={i}
                                                    className="flex h-8 items-center rounded-md px-3"
                                                >
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
                                            className={`px-5 py-2 text-xs text-gray-500 ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            No projects yet
                                        </div>
                                    ) : (
                                        <div
                                            className={`space-y-1 px-2 pb-1 ${
                                                shouldAnimate
                                                    ? "sidebar-fade-in-2"
                                                    : ""
                                            }`}
                                        >
                                            {displayedRecentProjects.map(
                                                (project) => {
                                                    const isActive =
                                                        pathname ===
                                                            `/projects/${project.id}` ||
                                                        pathname.startsWith(
                                                            `/projects/${project.id}/`,
                                                        );
                                                    return (
                                                        <button
                                                            key={project.id}
                                                            onClick={() =>
                                                                router.push(
                                                                    `/projects/${project.id}`,
                                                                )
                                                            }
                                                            title={project.name}
                                                            className={cn(
                                                                "flex h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors",
                                                                isActive
                                                                    ? `${LIQUID_GLASS_SELECTED_CLASS} text-gray-900`
                                                                    : `text-gray-700 ${LIQUID_GLASS_HOVER_CLASS}`,
                                                            )}
                                                        >
                                                            <ProjectSvgIcon
                                                                open={isActive}
                                                                className="h-3.5 w-3.5 shrink-0"
                                                            />
                                                            <span className="min-w-0 flex-1 truncate">
                                                                {project.name}
                                                            </span>
                                                        </button>
                                                    );
                                                },
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
                                className={`mb-2 flex w-full items-center justify-between px-4 text-xs font-semibold text-gray-500 transition-colors hover:text-gray-700 ${
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
                                    <div className="space-y-1.5 px-2">
                                        {[40, 60, 50, 70, 45].map((w, i) => (
                                            <div
                                                key={i}
                                                className="flex h-8 items-center rounded-md px-2.5"
                                            >
                                                <div className="mr-2 h-3.5 w-3.5 shrink-0 rounded bg-gray-200 animate-pulse" />
                                                <div
                                                    className="h-3 bg-gray-200 rounded animate-pulse"
                                                    style={{ width: `${w}%` }}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                ) : chats.length === 0 ? (
                                    <div
                                        className={`text-xs text-gray-500 py-2 px-4 ${
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
                                            className={`space-y-1.5 px-2 ${
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
                        <div className="relative">
                            <button
                                type="button"
                                aria-expanded={isDropdownOpen}
                                aria-controls="account-dropdown"
                                aria-label="Account menu"
                                onClick={() =>
                                    setIsDropdownOpen(!isDropdownOpen)
                                }
                                className={cn(
                                    "flex h-12 w-full shrink-0 items-center rounded-xl px-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
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
                                        className={`text-left flex-1 min-w-0 pl-3 flex items-center justify-between gap-2 ${
                                            shouldAnimate
                                                ? "sidebar-fade-in-2"
                                                : ""
                                        }`}
                                    >
                                        <div className="flex flex-col gap-0.5 min-w-0">
                                            <div className="text-xs font-medium text-gray-900 leading-none">
                                                {getDisplayName()}
                                            </div>
                                            <div className="text-[11px] text-gray-500 leading-none">
                                                {getUserTier()}
                                            </div>
                                        </div>
                                        <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-gray-400" />
                                    </div>
                                )}
                            </button>

                            {isDropdownOpen && (
                                <div
                                    id="account-dropdown"
                                    className={cn(
                                        "absolute bottom-full left-0 z-50 mb-1 p-1 whitespace-nowrap",
                                        isOpen ? "right-0" : "w-56",
                                        `${LIQUID_GLASS_FLOAT_CLASS} rounded-xl backdrop-blur-xl`,
                                    )}
                                >
                                    <button
                                        type="button"
                                        onClick={() => {
                                            router.push("/history");
                                            setIsDropdownOpen(false);
                                        }}
                                        className={cn(
                                            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-gray-700",
                                            LIQUID_GLASS_HOVER_CLASS,
                                            pathname === "/history" &&
                                                LIQUID_GLASS_SELECTED_CLASS,
                                        )}
                                    >
                                        <HistorySkeuoIcon className="h-4 w-4" />
                                        History
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            router.push("/settings");
                                            setIsDropdownOpen(false);
                                        }}
                                        className={cn(
                                            "w-full px-2 py-2 text-left text-sm text-gray-700 flex items-center gap-2 rounded-md",
                                            LIQUID_GLASS_HOVER_CLASS,
                                        )}
                                    >
                                        <SettingsSkeuoIcon className="h-4 w-4" />
                                        Settings
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            router.push("/organizations");
                                            setIsDropdownOpen(false);
                                        }}
                                        className={cn(
                                            "w-full px-2 py-2 text-left text-sm text-gray-700 flex items-center gap-2 rounded-md",
                                            LIQUID_GLASS_HOVER_CLASS,
                                        )}
                                    >
                                        <OrganizationSkeuoIcon className="h-4 w-4" />
                                        Organizations
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsDropdownOpen(false);
                                            handleSignOut();
                                        }}
                                        className={cn(
                                            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-gray-700",
                                            LIQUID_GLASS_HOVER_CLASS,
                                        )}
                                    >
                                        <SignOutSkeuoIcon className="h-4 w-4" />
                                        Sign out
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}
