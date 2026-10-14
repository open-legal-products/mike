import type { ReactNode } from "react";

type EventDotColor = "green" | "gray" | "red";

function EventConnector() {
    return (
        <div className="absolute left-[3px] top-[14px] h-[calc(100%+10px)] w-[1px] -translate-x-1/2 bg-gray-300" />
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

export function DocReadBlockUI({
    filename,
    fileIcon,
    onClick,
    showConnector,
    isStreaming,
}: {
    filename?: string;
    fileIcon?: ReactNode;
    onClick?: () => void;
    showConnector?: boolean;
    isStreaming?: boolean;
}) {
    const file = filename ? (
        <>
            {fileIcon}
            <span className="truncate">
                {filename}
                {isStreaming && "..."}
            </span>
        </>
    ) : isStreaming ? (
        <span>...</span>
    ) : null;

    return (
        <DocumentEventBlockUI
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor="green"
        >
            <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-medium">
                    {isStreaming ? "Reading" : "Read"}
                </span>
                {!isStreaming && onClick ? (
                    <button
                        type="button"
                        onClick={onClick}
                        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-gray-700"
                    >
                        {file}
                    </button>
                ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                        {file}
                    </span>
                )}
            </div>
        </DocumentEventBlockUI>
    );
}

export function DocFindBlockUI({
    filename,
    query,
    totalMatches,
    isStreaming,
    showConnector,
    onClick,
}: {
    filename: string;
    query: string;
    totalMatches: number;
    isStreaming?: boolean;
    showConnector?: boolean;
    onClick?: () => void;
}) {
    const matchSuffix = isStreaming
        ? ""
        : ` (${totalMatches} ${totalMatches === 1 ? "match" : "matches"})`;

    return (
        <DocumentEventBlockUI
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={totalMatches > 0 ? "green" : "gray"}
        >
            <span className="font-medium">
                {isStreaming ? "Finding" : "Found"}
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
                    {!isStreaming && onClick ? (
                        <button
                            type="button"
                            onClick={onClick}
                            className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-gray-700"
                        >
                            {fileIcon}
                            <span className="truncate">{filename}</span>
                        </button>
                    ) : (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                            {fileIcon}
                            <span className="truncate">
                                {isStreaming ? `${filename}...` : filename}
                            </span>
                        </span>
                    )}
                </span>
            )}
            {detail && <span className="ml-1 text-gray-400">{detail}</span>}
        </DocumentEventBlockUI>
    );
}
