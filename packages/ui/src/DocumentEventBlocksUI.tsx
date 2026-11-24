import type { ReactNode } from "react";
export { TextCardUI } from "./TextCardUI";

type EventDotColor = "green" | "gray" | "red";

function EventConnector() {
    return (
        <div
            aria-hidden="true"
            data-slot="event-connector"
            className="absolute left-[3px] top-[14px] h-[calc(100%+10px)] w-[1px] -translate-x-1/2 bg-gray-300"
        />
    );
}

function DocumentEventBlockUI({
    children,
    showConnector,
    isStreaming,
    dotColor = "green",
}: {
    children: ReactNode;
    showConnector?: boolean;
    isStreaming?: boolean;
    dotColor?: EventDotColor;
}) {
    const dotColorClass =
        dotColor === "green"
            ? "bg-green-400 shadow-[0_1px_3px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.5)]"
            : dotColor === "red"
              ? "bg-red-400 shadow-[0_1px_3px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.5)]"
              : "bg-gray-500 shadow-[0_1px_3px_rgba(15,23,42,0.15)]";

    return (
        <div className="relative flex items-start font-serif text-sm text-gray-500">
            {showConnector && <EventConnector />}
            {isStreaming ? (
                <div className="mt-2 h-1.5 w-1.5 shrink-0 animate-spin rounded-full border border-gray-400 border-t-transparent" />
            ) : (
                <div
                    className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dotColorClass}`}
                />
            )}
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                {children}
            </div>
        </div>
    );
}

/**
 * A source an event step names (a file, a case, a statute): its icon and
 * name, and a button when the step can open it.
 */
export function EventSourceUI({
    name,
    icon,
    onClick,
    isStreaming,
}: {
    name: string;
    icon?: ReactNode;
    /** Opens the source; ignored while the step is still running. */
    onClick?: () => void;
    isStreaming?: boolean;
}) {
    const content = (
        <>
            {icon}
            <span className="truncate">
                {name}
                {isStreaming && "..."}
            </span>
        </>
    );
    return !isStreaming && onClick ? (
        <button
            type="button"
            onClick={onClick}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-left align-middle transition-colors hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
            {content}
        </button>
    ) : (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle">
            {content}
        </span>
    );
}

export function DocReadBlockUI({
    filename,
    fileIcon,
    onClick,
    showConnector,
    isStreaming,
    interrupted,
}: {
    filename?: string;
    fileIcon?: ReactNode;
    onClick?: () => void;
    showConnector?: boolean;
    isStreaming?: boolean;
    /** The turn ended before the read reported its result. */
    interrupted?: boolean;
}) {

    return (
        <DocumentEventBlockUI
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={interrupted ? "gray" : "green"}
        >
            <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-medium">
                    {isStreaming ? "Reading" : interrupted ? "Read stopped" : "Read"}
                </span>
                {filename ? (
                    <EventSourceUI
                        name={filename}
                        icon={fileIcon}
                        onClick={onClick}
                        isStreaming={isStreaming}
                    />
                ) : isStreaming ? (
                    <span>...</span>
                ) : null}
            </div>
        </DocumentEventBlockUI>
    );
}

export function DocFindBlockUI({
    filename,
    query,
    totalMatches,
    isStreaming,
    interrupted,
    showConnector,
    onClick,
}: {
    filename: string;
    query: string;
    totalMatches: number;
    isStreaming?: boolean;
    /** The turn ended before the find reported its matches. */
    interrupted?: boolean;
    showConnector?: boolean;
    onClick?: () => void;
}) {
    // A find that never reported has no match count, not zero matches.
    const matchSuffix =
        isStreaming || interrupted
            ? ""
            : ` (${totalMatches} ${totalMatches === 1 ? "match" : "matches"})`;

    return (
        <DocumentEventBlockUI
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={!interrupted && totalMatches > 0 ? "green" : "gray"}
        >
            <span className="font-medium">
                {isStreaming ? "Finding" : interrupted ? "Find stopped" : "Found"}
            </span>{" "}
            <span>
                &ldquo;{query}&rdquo;{matchSuffix}
                <span className="ml-1 text-gray-400">in </span>
                {!isStreaming && onClick ? (
                    <button
                        type="button"
                        onClick={onClick}
                        className="cursor-pointer text-left text-gray-400 transition-colors hover:text-gray-700"
                    >
                        {filename}
                    </button>
                ) : (
                    <span className="text-gray-400">{filename}</span>
                )}
                {isStreaming && "..."}
            </span>
        </DocumentEventBlockUI>
    );
}

export function DocEditBlockUI({
    label,
    filename,
    fileIcon,
    detail,
    onClick,
    showConnector,
    isStreaming,
    dotColor = "green",
    labelTone = "default",
}: {
    label: string;
    filename?: string;
    fileIcon?: ReactNode;
    detail?: ReactNode;
    onClick?: () => void;
    showConnector?: boolean;
    isStreaming?: boolean;
    dotColor?: EventDotColor;
    labelTone?: "default" | "error";
}) {
    return (
        <DocumentEventBlockUI
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={dotColor}
        >
            <span
                className={`font-medium ${labelTone === "error" ? "text-red-500" : ""}`}
            >
                {label}
            </span>
            {filename && (
                <span className="ml-1 inline-flex min-w-0 align-middle">
                    <EventSourceUI
                        name={filename}
                        icon={fileIcon}
                        onClick={onClick}
                        isStreaming={isStreaming}
                    />
                </span>
            )}
            {detail && <span className="ml-1 text-gray-400">{detail}</span>}
        </DocumentEventBlockUI>
    );
}
