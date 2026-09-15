"use client";

import { useCallback, useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { ChatHistoryProvider } from "@/app/contexts/ChatHistoryContext";
import { SidebarContext } from "@/app/contexts/SidebarContext";
import { PageChromeContext } from "@/app/contexts/PageChromeContext";
import { AppSidebar } from "@/app/components/shared/AppSidebar";
import { FullScreenLoader } from "@/app/components/shared/FullScreenLoader";
import { HeaderButtonUI, HeaderButtonsUI } from "@/shared/ui/HeaderButtonsUI";
import { cn } from "@/app/lib/utils";

export default function MikeLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, authLoading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const isChatPage =
        /^\/assistant\/chat\/[^/]+\/?$/.test(pathname) ||
        /^\/projects\/[^/]+\/assistant\/chat\/[^/]+\/?$/.test(pathname);
    const [mobileActionsContainer, setMobileActionsContainer] =
        useState<HTMLDivElement | null>(null);

    const [isSidebarOpenDesktop, setIsSidebarOpenDesktop] = useState(() => {
        if (typeof window !== "undefined") {
            const saved = localStorage.getItem("sidebarOpen");
            return saved !== null ? saved === "true" : true;
        }
        return true;
    });

    const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
        if (typeof window !== "undefined" && window.innerWidth < 768) {
            return false;
        }
        return true;
    });

    useEffect(() => {
        if (typeof window !== "undefined" && window.innerWidth >= 768) {
            localStorage.setItem("sidebarOpen", isSidebarOpen.toString());
        }
    }, [isSidebarOpenDesktop]);

    useEffect(() => {
        if (typeof window === "undefined") return;
        const handleResize = () => {
            const isSmall = window.innerWidth < 768;
            if (isSmall && isSidebarOpen) setIsSidebarOpen(false);
            else if (!isSmall && !isSidebarOpen)
                setIsSidebarOpen(isSidebarOpenDesktop);
        };
        window.addEventListener("resize", handleResize);
        return () => window.removeEventListener("resize", handleResize);
    }, [isSidebarOpen, isSidebarOpenDesktop]);

    const handleSidebarToggle = () => {
        if (window.innerWidth >= 768) {
            setIsSidebarOpenDesktop(!isSidebarOpenDesktop);
            setIsSidebarOpen(!isSidebarOpenDesktop);
        } else {
            setIsSidebarOpen(!isSidebarOpen);
        }
    };

    const handleMobileActionsContainerRef = useCallback(
        (node: HTMLDivElement | null) => {
            setMobileActionsContainer(node);
        },
        [],
    );

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/login");
        }
    }, [authLoading, isAuthenticated, router]);

    if (authLoading) {
        return <FullScreenLoader />;
    }

    if (!isAuthenticated) return null;

    return (
        <ChatHistoryProvider>
            <PageChromeContext.Provider value={{ mobileActionsContainer }}>
                <SidebarContext.Provider
                    value={{
                        setSidebarOpen: (open) => {
                            const isSmall =
                                typeof window !== "undefined" &&
                                window.innerWidth < 768;
                            if (isSmall) {
                                if (!open) setIsSidebarOpen(false);
                                return;
                            }
                            setIsSidebarOpen(open);
                            setIsSidebarOpenDesktop(open);
                        },
                    }}
                >
                    <div className="h-dvh flex flex-col bg-app-background">
                        <div className="flex-1 flex min-w-0 overflow-visible">
                            <AppSidebar
                                isOpen={isSidebarOpen}
                                onToggle={handleSidebarToggle}
                            />
                            <div className="flex-1 flex flex-col h-dvh md:overflow-hidden relative w-full">
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
                                    <HeaderButtonsUI className="pointer-events-auto">
                                        <HeaderButtonUI
                                            iconOnly
                                            onClick={handleSidebarToggle}
                                            title="Open sidebar"
                                            aria-label="Open sidebar"
                                        >
                                            <PanelLeft className="h-4 w-4" />
                                        </HeaderButtonUI>
                                    </HeaderButtonsUI>
                                    <div
                                        ref={handleMobileActionsContainerRef}
                                        className="pointer-events-auto ml-auto flex min-w-0 flex-1 items-center justify-end"
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
    );
}
