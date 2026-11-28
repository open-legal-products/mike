"use client";

import { createContext, useContext, type ComponentProps } from "react";
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
 *
 * Only from md up, where the sidebar sits beside it. On a small screen the
 * page is the window's own: no inset, no glass (globals.css clears the
 * material there), and the title moves into the top bar.
 */
export function PageSheet({
    children,
    className,
    ...props
}: ComponentProps<"div">) {
    return (
        <PageSheetContext.Provider value>
            <div
                {...props}
                data-slot="page-sheet"
                className={cn(
                    "flex min-h-0 flex-1 flex-col overflow-hidden md:my-3 md:ml-2 md:mr-3 md:rounded-2xl",
                    LIQUID_GLASS_FLOAT_CLASS,
                    className,
                )}
            >
                {children}
            </div>
        </PageSheetContext.Provider>
    );
}
