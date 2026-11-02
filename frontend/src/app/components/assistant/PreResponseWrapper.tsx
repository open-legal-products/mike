"use client";

import type { ReactNode } from "react";
import { PreResponseWrapperUI } from "@/shared/ui/PreResponseWrapperUI";

export function PreResponseWrapper({
    children,
    stepCount,
    subagentCount,
    shouldMinimize,
    isStreaming,
    forceOpen = false,
}: {
    children: ReactNode;
    stepCount: number;
    subagentCount?: number;
    shouldMinimize: boolean;
    isStreaming: boolean;
    forceOpen?: boolean;
}) {
    return (
        <PreResponseWrapperUI
            stepCount={stepCount}
            subagentCount={subagentCount}
            shouldMinimize={shouldMinimize}
            isStreaming={isStreaming}
            forceOpen={forceOpen}
        >
            {children}
        </PreResponseWrapperUI>
    );
}
