"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { GlassCardUI } from "./GlassCardUI";

export interface PreResponseWrapperUIProps {
    children: ReactNode;
    stepCount: number;
    shouldMinimize: boolean;
    isStreaming: boolean;
    forceOpen?: boolean;
}

function ActivityList({ children }: { children: ReactNode }) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const [hasMoreBelow, setHasMoreBelow] = useState(false);
    const hasMoreBelowRef = useRef(false);

    useEffect(() => {
        const viewport = viewportRef.current;
        const content = contentRef.current;
        if (!viewport || !content) return;

        let frame: number | null = null;
        let disposed = false;
        const measure = () => {
            frame = null;
            if (disposed) return;
            const next = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 2;
            // Streamed events can trigger many resizes; dispatch only when
            // the fade changes, without an effect tied to incoming children.
            if (next === hasMoreBelowRef.current) return;
            hasMoreBelowRef.current = next;
            setHasMoreBelow(next);
        };
        const scheduleMeasure = () => {
            if (!disposed && frame === null) frame = requestAnimationFrame(measure);
        };
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
        observer?.observe(viewport);
        observer?.observe(content);
        viewport.addEventListener("scroll", scheduleMeasure, { passive: true });
        scheduleMeasure();
        return () => {
            disposed = true;
            observer?.disconnect();
            viewport.removeEventListener("scroll", scheduleMeasure);
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, []);

    return (
        <div className="relative mt-3">
            <div
                ref={viewportRef}
                role="region"
                aria-label="Assistant activity"
                tabIndex={0}
                className="max-h-80 overflow-y-auto overscroll-contain rounded-b-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
                <div ref={contentRef} className="flex flex-col gap-4 px-3 pb-2">
                    {children}
                </div>
            </div>
            {hasMoreBelow && (
                <div
                    aria-hidden="true"
                    data-slot="activity-scroll-fade"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-10 rounded-b-xl backdrop-blur-xs [mask-image:linear-gradient(to_bottom,transparent,black)]"
                />
            )}
        </div>
    );
}

/**
 * Platform-neutral disclosure for pre-answer activity. Hosts supply activity
 * rows and surface styling; this component owns only presentation and local
 * disclosure behavior.
 */
export function PreResponseWrapperUI({
    children,
    stepCount,
    shouldMinimize,
    isStreaming,
    forceOpen = false,
}: PreResponseWrapperUIProps) {
    const [userToggled, setUserToggled] = useState(false);
    const [isOpen, setIsOpen] = useState(!shouldMinimize);
    // Once answer content causes a minimize, do not reopen during a transient
    // streaming-state render unless the host explicitly forces the panel open.
    const hasMinimizedRef = useRef(shouldMinimize);

    useEffect(() => {
        if (forceOpen) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronizes the disclosure with host streaming state
            setIsOpen(true);
            return;
        }
        if (shouldMinimize) hasMinimizedRef.current = true;
        if (userToggled) return;
        setIsOpen(!shouldMinimize && !hasMinimizedRef.current);
    }, [forceOpen, shouldMinimize, userToggled]);

    const stepWord = `step${stepCount === 1 ? "" : "s"}`;
    const label = isStreaming
        ? "Working"
        : `Completed in ${stepCount} ${stepWord}`;

    return (
        <GlassCardUI>
            <button
                type="button"
                onClick={() => {
                    setUserToggled(true);
                    setIsOpen((value) => !value);
                }}
                aria-expanded={isOpen}
                className={`flex w-full items-center justify-between rounded-xl px-3 font-serif text-sm text-gray-500 transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${isOpen ? "pt-2" : "py-2"}`}
            >
                <span className="flex min-w-0 items-baseline">
                    <span className="truncate">{label}</span>
                    {isStreaming && (
                        <span
                            className="ml-1 inline-flex shrink-0 items-baseline"
                            aria-hidden="true"
                        >
                            <span className="mr-0.5 h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0s]" />
                            <span className="mr-0.5 h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0.2s]" />
                            <span className="h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0.4s]" />
                        </span>
                    )}
                </span>
                <ChevronDown
                    aria-hidden="true"
                    className={`relative top-px ml-2 h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                />
            </button>

            {isOpen && <ActivityList>{children}</ActivityList>}
        </GlassCardUI>
    );
}
