"use client";

import { useCallback, useMemo, useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { WorkspaceProvider } from "@/app/contexts/WorkspaceContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import { AppSidebar } from "@/app/components/shared/AppSidebar";
import { useResponsiveSidebar } from "@/app/hooks/useResponsiveSidebar";
import { useContentAreaInsets } from "@/app/hooks/useContentAreaInsets";
import { preloadSidebarIcons } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { HeaderButtonUI, HeaderButtonsUI } from "@mike/ui";
import { cn } from "@/app/lib/utils";

export default function MikeLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    preloadSidebarIcons();
    const { isAuthenticated, authLoading } = useAuth();
    const [hasMounted, setHasMounted] = useState(false);
    useEffect(() => {
        // An outer auth provider may settle before this streamed boundary
        // hydrates. Its first client render must still match the SSR loader.
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one hydration transition, independent of auth or streamed content
        setHasMounted(true);
    }, []);
    const router = useRouter();
    const pathname = usePathname();
    const isChatPage =
        /^\/assistant\/chat\/[^/]+\/?$/.test(pathname) ||
        /^\/projects\/[^/]+\/assistant\/chat\/[^/]+\/?$/.test(pathname);
    const [mobileActionsContainer, setMobileActionsContainer] =
        useState<HTMLDivElement | null>(null);
    const [mobileBackContainer, setMobileBackContainer] =
        useState<HTMLDivElement | null>(null);
    const [mobileTitleContainer, setMobileTitleContainer] =
        useState<HTMLDivElement | null>(null);

    // Where the page beside the sidebar sits, for notices and confirmations
    // to centre on.
    const contentAreaRef = useContentAreaInsets();

    const {
        isOpen: isSidebarOpen,
        toggle: handleSidebarToggle,
        setOpen: setSidebarOpen,
    } = useResponsiveSidebar();

    const handleMobileActionsContainerRef = useCallback(
        (node: HTMLDivElement | null) => {
            setMobileActionsContainer(node);
        },
        [],
    );

    const handleMobileBackContainerRef = useCallback(
        (node: HTMLDivElement | null) => {
            setMobileBackContainer(node);
        },
        [],
    );

    const handleMobileTitleContainerRef = useCallback(
        (node: HTMLDivElement | null) => {
            setMobileTitleContainer(node);
        },
        [],
    );

    const pageChromeValue = useMemo(
        () => ({
            mobileActionsContainer,
            mobileBackContainer,
            mobileTitleContainer,
        }),
        [mobileActionsContainer, mobileBackContainer, mobileTitleContainer],
    );

    const sidebarValue = useMemo(() => ({ setSidebarOpen }), [setSidebarOpen]);

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    if (!hasMounted || authLoading) {
        return <FullScreenLoader />;
    }

    if (!isAuthenticated) return null;

    return (
        <WorkspaceProvider>
            <ChatHistoryProvider>
                <PageChromeContext.Provider value={pageChromeValue}>
                    <SidebarContext.Provider value={sidebarValue}>
                        <div className="h-dvh flex flex-col bg-app-background">
                            <div className="flex-1 flex min-w-0 overflow-visible">
                                <AppSidebar
                                    isOpen={isSidebarOpen}
                                    onToggle={handleSidebarToggle}
                                />
                                <div
                                    ref={contentAreaRef}
                                    data-slot="content-area"
                                    className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full"
                                >
                                    {/* Mobile header */}
                                    <div
                                        data-slot="mobile-header"
                                        className={cn(
                                            "z-30 flex items-center gap-3 overflow-visible px-4 md:hidden",
                                            isChatPage
                                                ? "pointer-events-none fixed inset-x-0 top-0 bg-transparent pb-2 pt-3"
                                                : "relative shrink-0 pb-2 pt-3",
                                        )}
                                    >
                                        <HeaderButtonsUI
                                            className={cn(
                                                "pointer-events-auto",
                                                // Only the chat page floats this
                                                // bar over scrolling content.
                                                isChatPage && "backdrop-blur-2xl",
                                            )}
                                        >
                                            <HeaderButtonUI
                                                iconOnly
                                                onClick={handleSidebarToggle}
                                                title="Open sidebar"
                                                aria-label="Open sidebar"
                                            >
                                                <PanelLeft className="h-4 w-4" />
                                            </HeaderButtonUI>
                                        </HeaderButtonsUI>
                                        {/* A page's way back, drawn here by
                                            its breadcrumbs. */}
                                        <div
                                            ref={handleMobileBackContainerRef}
                                            data-slot="mobile-back"
                                            className="pointer-events-auto flex shrink-0 empty:hidden"
                                        />
                                        {/* A sheet page's title, after the
                                            buttons on the left. */}
                                        <div
                                            ref={handleMobileTitleContainerRef}
                                            data-slot="mobile-title"
                                            className="pointer-events-auto flex min-w-0 flex-1 items-center empty:hidden"
                                        />
                                        {/* Beside a title, only as wide as
                                            its buttons; the title takes the
                                            rest. */}
                                        <div
                                            ref={handleMobileActionsContainerRef}
                                            className="pointer-events-auto ml-auto flex min-w-0 flex-1 items-center justify-end [[data-slot=mobile-title]:not(:empty)~&]:flex-initial"
                                        />
                                    </div>
                                    <main className="flex h-full w-full flex-1 flex-col overflow-y-auto md:overflow-hidden">
                                        {children}
                                    </main>
                                </div>
                            </div>
                        </div>
                    </SidebarContext.Provider>
                </PageChromeContext.Provider>
            </ChatHistoryProvider>
        </WorkspaceProvider>
    );
}
