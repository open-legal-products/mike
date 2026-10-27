"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import {
    VISUAL_INNER_SANDBOX,
    buildVisualHostDocument,
    parseVisualMessage,
    withVisualTheme,
    type VisualCite,
    type VisualTheme,
} from "../lib/visualBridge";
import { TextButtonUI } from "./TextButtonUI";

export type VisualViewUIProps = {
    html: string;
    title: string;
    theme: VisualTheme;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    active?: boolean;
    onCite?: (cite: VisualCite) => void;
    className?: string;
};

const CITE_INTERVAL_MS = 400;
const LOAD_FALLBACK_MS = 1500;
const DRAW_FAILED_MESSAGE = "This visual could not be drawn.";

function VisualSkeleton() {
    return (
        <>
            <div
                aria-hidden="true"
                className="absolute inset-0 flex flex-col gap-4 overflow-hidden bg-background p-6 animate-pulse"
            >
                <div className="flex flex-col gap-2">
                    <div className="h-5 w-2/5 rounded bg-muted" />
                    <div className="h-3 w-3/5 rounded bg-muted" />
                </div>
                <div className="grid flex-1 grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="min-h-32 rounded-lg bg-muted" />
                    <div className="min-h-32 rounded-lg bg-muted" />
                </div>
            </div>
            <span role="status" className="sr-only">
                Loading visual
            </span>
        </>
    );
}

function VisualError({
    message,
    onRetry,
}: {
    message: string;
    onRetry?: () => void;
}) {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <p>{message}</p>
            {onRetry && (
                <TextButtonUI size="sm" onClick={onRetry}>
                    Try again
                </TextButtonUI>
            )}
        </div>
    );
}

function VisualFrame({
    srcDoc,
    title,
    theme,
    active,
    onCite,
    onError,
}: {
    srcDoc: string;
    title: string;
    theme: VisualTheme;
    active: boolean;
    onCite?: (cite: VisualCite) => void;
    onError: () => void;
}) {
    const frameRef = useRef<HTMLIFrameElement>(null);
    const [ready, setReady] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const lastCiteRef = useRef(0);
    const activeRef = useRef(active);
    const onCiteRef = useRef(onCite);
    const onErrorRef = useRef(onError);
    useEffect(() => {
        activeRef.current = active;
        onCiteRef.current = onCite;
        onErrorRef.current = onError;
    }, [active, onCite, onError]);
    const cites = !!onCite;

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const frame = frameRef.current;
            if (!frame?.contentWindow || event.source !== frame.contentWindow) {
                return;
            }
            const message = parseVisualMessage(event.data);
            if (!message) return;
            if (message.type === "mike:ready") {
                setReady(true);
                return;
            }
            if (message.type === "mike:error") {
                onErrorRef.current();
                return;
            }
            if (activeRef.current === false || !onCiteRef.current) return;
            const now = Date.now();
            if (now - lastCiteRef.current < CITE_INTERVAL_MS) return;
            lastCiteRef.current = now;
            onCiteRef.current(message.cite);
        };
        window.addEventListener("message", handleMessage);
        return () => window.removeEventListener("message", handleMessage);
    }, []);

    useEffect(() => {
        if (!ready) return;
        frameRef.current?.contentWindow?.postMessage(
            { type: "mike:host", theme, cites },
            "*",
        );
    }, [ready, theme, cites]);

    useEffect(() => {
        if (!loaded || ready) return;
        const timer = window.setTimeout(() => setReady(true), LOAD_FALLBACK_MS);
        return () => window.clearTimeout(timer);
    }, [loaded, ready]);

    return (
        <>
            {/* Never add allow-same-origin: the visual's scripts would then
                run in the app's origin, read the session and call the API
                as the signed-in user. */}
            <iframe
                ref={frameRef}
                data-mike-visual-frame
                sandbox={VISUAL_INNER_SANDBOX}
                srcDoc={srcDoc}
                referrerPolicy="no-referrer"
                title={title}
                onLoad={() => setLoaded(true)}
                className={clsx(
                    "h-full w-full border-0 bg-transparent",
                    !ready && "opacity-0",
                )}
            />
            {!ready && <VisualSkeleton />}
        </>
    );
}

export function VisualViewUI({
    html,
    title,
    theme,
    loading = false,
    error = null,
    onRetry,
    active = true,
    onCite,
    className,
}: VisualViewUIProps) {
    // The theme is baked into the document so a dark visual never flashes
    // light before it is ready. A later switch goes through the host message
    // without reloading the frame; only a new document picks up the current
    // theme.
    const [baked, setBaked] = useState({ html, theme });
    if (baked.html !== html) setBaked({ html, theme });
    const srcDoc = useMemo(
        () => buildVisualHostDocument(withVisualTheme(html, baked.theme), title),
        [html, title, baked.theme],
    );
    // The same document draws the same way, so a draw failure is final for
    // that document and clears only when another one arrives.
    const [failedSrcDoc, setFailedSrcDoc] = useState<string | null>(null);
    const drawError = failedSrcDoc === srcDoc ? DRAW_FAILED_MESSAGE : null;

    return (
        <div
            className={twMerge(
                clsx(
                    "relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden focus-within:ring-2 focus-within:ring-inset focus-within:ring-blue-500/40",
                    className,
                ),
            )}
        >
            {error ? (
                <VisualError message={error} onRetry={onRetry} />
            ) : drawError ? (
                <VisualError message={drawError} />
            ) : loading ? (
                <VisualSkeleton />
            ) : (
                <VisualFrame
                    key={srcDoc}
                    srcDoc={srcDoc}
                    title={title}
                    theme={theme}
                    active={active}
                    onCite={onCite}
                    onError={() => setFailedSrcDoc(srcDoc)}
                />
            )}
        </div>
    );
}
