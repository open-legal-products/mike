"use client";

import { createContext, useContext, type ReactNode } from "react";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/app/components/ui/liquid-surface";
import { cn } from "@/app/lib/utils";

const PageSheetContext = createContext(false);

/**
 * Whether the caller is drawn on a page sheet. A page's header and toolbar
 * drop their own glass there: glass on glass reads as clutter, not depth.
 */
export function useOnPageSheet() {
    return useContext(PageSheetContext);
}

/**
 * A whole page on one liquid-glass sheet, inset from the window's edges the
 * way the IDE's empty state is. Its header, toolbar and table go inside. It is
 * the sidebar's material (float), so the two read as a pair of panels.
 */
export function PageSheet({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <PageSheetContext.Provider value>
            <div
                data-slot="page-sheet"
                className={cn(
                    "my-2 ml-2 mr-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl md:my-3",
                    LIQUID_GLASS_FLOAT_CLASS,
                    className,
                )}
            >
                {children}
            </div>
        </PageSheetContext.Provider>
    );
}
