"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import {
    PlaybookRunCompleteIcon,
    PlaybookSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
} from "@/app/components/ui/liquid-surface";
import type { PlaybookRunHistoryItem } from "@/app/lib/mikeApi";
import { playbookRunPath } from "@/app/lib/playbookRunActivity";
import { cn } from "@/app/lib/utils";
import {
    SIDEBAR_TITLE_SLIDE_CLASS,
    useSidebarTitleSlide,
} from "./useSidebarTitleSlide";

/** A playbook run in History: "Playbook: document", opening the run. */
export function SidebarPlaybookRunItem({
    run,
    isActive,
    status,
    onOpen,
}: {
    run: PlaybookRunHistoryItem;
    isActive: boolean;
    status?: "loading" | "complete";
    onOpen: () => void;
}) {
    const { titleRef, titleStyle, slideHandlers } = useSidebarTitleSlide();
    const documentName = run.documentName?.trim() || "Untitled document";
    const playbookName = run.playbookName.trim() || "Untitled playbook";
    const fullTitle = `${playbookName}: ${documentName}`;
    return (
        <Link
            href={playbookRunPath(run)}
            title={fullTitle}
            aria-label={`Playbook run: ${fullTitle}${status === "loading" ? " (Running)" : status === "complete" ? " (Complete)" : ""}`}
            onClick={onOpen}
            aria-current={isActive ? "page" : undefined}
            {...slideHandlers}
            className={cn(
                "flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40",
                isActive
                    ? `${LIQUID_GLASS_SELECTED_CLASS} text-gray-900`
                    : `${LIQUID_GLASS_HOVER_CLASS} text-gray-700`,
            )}
        >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {status === "loading" ? (
                    <Loader2
                        role="status"
                        aria-label={`${documentName} review running`}
                        className="h-3.5 w-3.5 animate-spin text-blue-600 motion-reduce:animate-none"
                    />
                ) : status === "complete" ? (
                    <PlaybookRunCompleteIcon className="h-3.5 w-3.5" />
                ) : (
                    <PlaybookSkeuoIcon className="h-3.5 w-3.5" />
                )}
            </span>
            {/* Clips the title, which slides to show its end on hover. */}
            <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">
                <span
                    ref={titleRef}
                    className={SIDEBAR_TITLE_SLIDE_CLASS}
                    style={titleStyle}
                >
                    <span className="text-gray-400 font-normal">
                        {playbookName}:{" "}
                    </span>
                    {documentName}
                </span>
            </span>
        </Link>
    );
}
