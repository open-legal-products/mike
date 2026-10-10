"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/app/lib/utils";

const KEYBOARD_STEP_PX = 24;
const MIN_CHAT_WIDTH = 320;

/**
 * The side chat's share of the two chats' combined width after the line
 * between them moves `dx` pixels to the right. Neither chat goes below its
 * minimum; with no room for two minimums they split evenly.
 */
export function resizedSideChatShare(
    primaryWidth: number,
    sideWidth: number,
    dx: number,
): number {
    const total = primaryWidth + sideWidth;
    if (total < MIN_CHAT_WIDTH * 2) return 0.5;
    const nextSideWidth = Math.min(
        total - MIN_CHAT_WIDTH,
        Math.max(MIN_CHAT_WIDTH, sideWidth - dx),
    );
    return nextSideWidth / total;
}

/**
 * The line between two chats shown side by side. Dragging it, or the arrow
 * keys while it has focus, moves the boundary by the reported pixels
 * (positive is rightwards).
 */
export function AssistantChatDivider({
    onResize,
}: {
    onResize: (dx: number) => void;
}) {
    const [dragging, setDragging] = useState(false);
    const lastX = useRef(0);
    const onResizeRef = useRef(onResize);
    useEffect(() => {
        onResizeRef.current = onResize;
    }, [onResize]);

    useEffect(() => {
        if (!dragging) return;
        const onMouseMove = (event: MouseEvent) => {
            onResizeRef.current(event.clientX - lastX.current);
            lastX.current = event.clientX;
        };
        const onMouseUp = () => setDragging(false);
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
    }, [dragging]);

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chats"
            tabIndex={0}
            onMouseDown={(event) => {
                event.preventDefault();
                lastX.current = event.clientX;
                setDragging(true);
            }}
            onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    onResize(-KEYBOARD_STEP_PX);
                } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    onResize(KEYBOARD_STEP_PX);
                }
            }}
            // A hairline to look at, with a wider strip to grab.
            className="group relative z-20 hidden w-px shrink-0 cursor-col-resize bg-gray-200 focus-visible:outline-none md:block"
        >
            <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
            <div
                className={cn(
                    "pointer-events-none absolute inset-y-0 -left-px -right-px transition-colors group-hover:bg-blue-400/70 group-focus-visible:bg-blue-500",
                    dragging && "bg-blue-500",
                )}
            />
        </div>
    );
}
