import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Download, Loader2 } from "lucide-react";
import {
    EventDisclosureButton,
    EventLabel,
} from "@/app/components/assistant/message/EventDisclosure";
import { WorkflowSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { VersionChip } from "@/app/components/shared/VersionChip";
import { API_BASE } from "@/app/lib/mikeApi";
import { authenticatedFetch } from "@/app/lib/authEvents";
import type { AssistantEvent } from "../../shared/types";
import { FileTypeIcon } from "../../shared/FileTypeIcon";
import {
    DocEditBlockUI,
    DocFindBlockUI,
    DocReadBlockUI,
} from "@/shared/ui/DocumentEventBlocksUI";
import { RESPONSE_GLASS_SURFACE, withoutMarkdownNode } from "./messageStyles";

const THINKING_PHRASES = [
    "Thinking...",
    "Pondering...",
    "Analyzing...",
    "Reviewing...",
    "Reasoning...",
];
const REASONING_COLLAPSED_MAX_LINES = 6;
const REASONING_COLLAPSED_MAX_HEIGHT_REM = 9;

// ---------------------------------------------------------------------------
// Event block primitives
// ---------------------------------------------------------------------------

function EventConnector() {
    return (
        <div className="absolute w-[1px] bg-gray-300 top-[14px] left-[3px] translate-x-[-50%] h-[calc(100%+10px)]" />
    );
}

export function EventBlock({
    showConnector,
    isStreaming,
    dotColor = "green",
    children,
}: {
    showConnector?: boolean;
    isStreaming?: boolean;
    dotColor?: "green" | "gray" | "red";
    children: ReactNode;
}) {
    const dotColorClass =
        dotColor === "green"
            ? "bg-green-400 shadow-[0_1px_3px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.5)]"
            : dotColor === "red"
              ? "bg-red-400 shadow-[0_1px_3px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.5)]"
              : "bg-gray-500 shadow-[0_1px_3px_rgba(15,23,42,0.15)]";
    return (
        <div className="flex items-start text-sm font-serif text-gray-500 relative">
            {showConnector && <EventConnector />}
            {isStreaming ? (
                <div className="mt-2 w-1.5 h-1.5 shrink-0 rounded-full border border-gray-400 border-t-transparent animate-spin" />
            ) : (
                <div
                    className={`mt-2 w-1.5 h-1.5 shrink-0 rounded-full ${dotColorClass}`}
                />
            )}
            <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
                {children}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------

export function ReasoningBlock({
    text,
    isStreaming,
    showConnector,
}: {
    text: string;
    isStreaming: boolean;
    showConnector?: boolean;
}) {
    const [isContentOpen, setIsContentOpen] = useState(isStreaming);
    const [isExpanded, setIsExpanded] = useState(false);
    const [userToggledContent, setUserToggledContent] = useState(false);
    const [isOverflowing, setIsOverflowing] = useState(false);
    const [hasMeasured, setHasMeasured] = useState(false);
    const [thinkingIndex, setThinkingIndex] = useState(0);
    const contentRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!isStreaming) return;
        const interval = setInterval(() => {
            setThinkingIndex((i) => (i + 1) % THINKING_PHRASES.length);
        }, 2000);
        return () => clearInterval(interval);
    }, [isStreaming]);

    useEffect(() => {
        const el = contentRef.current;
        if (!el) return;
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
        const maxHeight = lineHeight * REASONING_COLLAPSED_MAX_LINES;
        const nextOverflowing = el.scrollHeight > maxHeight + 2;
        setIsOverflowing(nextOverflowing);
        setHasMeasured(true);
        if (!userToggledContent) setIsContentOpen(isStreaming);
        if (!nextOverflowing) setIsExpanded(false);
    }, [isContentOpen, isStreaming, text, userToggledContent]);

    const showContent = isContentOpen || (!userToggledContent && !hasMeasured);
    const isCollapsed = isContentOpen && isOverflowing && !isExpanded;

    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor="gray"
        >
            <EventDisclosureButton
                open={showContent}
                onToggle={() => {
                    setUserToggledContent(true);
                    setIsContentOpen((v) => !v);
                }}
                label={
                    isStreaming
                        ? THINKING_PHRASES[thinkingIndex]
                        : "Thought process"
                }
            />
            {showContent && (
                <div className="mt-2">
                    <div
                        className={`relative ${isCollapsed ? "overflow-hidden" : ""}`}
                        style={
                            isCollapsed
                                ? {
                                      maxHeight: `${REASONING_COLLAPSED_MAX_HEIGHT_REM}rem`,
                                  }
                                : undefined
                        }
                    >
                        <div
                            ref={contentRef}
                            className="text-sm font-serif text-gray-400 prose prose-sm max-w-none [&>*]:text-gray-400 [&>*]:text-sm"
                        >
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    code: (props) => (
                                        <code
                                            className="font-serif text-gray-600"
                                            {...withoutMarkdownNode(props)}
                                        />
                                    ),
                                }}
                            >
                                {text}
                            </ReactMarkdown>
                        </div>
                        {isCollapsed && (
                            <>
                                <div className="content-bottom-fade pointer-events-none absolute inset-x-0 bottom-0 h-10" />
                                <button
                                    type="button"
                                    onClick={() => setIsExpanded(true)}
                                    className="absolute left-1/2 bottom-2 z-10 -translate-x-1/2 text-gray-400 transition-colors hover:text-gray-600"
                                    aria-label="Expand thought process"
                                >
                                    <ChevronDown className="h-3.5 w-3.5" />
                                </button>
                            </>
                        )}
                    </div>
                    {isOverflowing && isContentOpen && isExpanded && (
                        <button
                            type="button"
                            onClick={() => setIsExpanded(false)}
                            className="mx-auto mt-2 flex text-gray-400 transition-colors hover:text-gray-600"
                            aria-label="Minimise thought process"
                        >
                            <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                        </button>
                    )}
                </div>
            )}
        </EventBlock>
    );
}

export function DocReadBlock({
    filename,
    onClick,
    showConnector,
    isStreaming,
    showFileIcon = true,
}: {
    filename: string;
    onClick?: () => void;
    showConnector?: boolean;
    isStreaming?: boolean;
    showFileIcon?: boolean;
}) {
    return (
        <DocReadBlockUI
            filename={filename}
            fileIcon={
                showFileIcon ? (
                    <FileTypeIcon fileType={filename} className="h-3.5 w-3.5" />
                ) : undefined
            }
            onClick={onClick}
            showConnector={showConnector}
            isStreaming={isStreaming}
        />
    );
}

export function DocFindBlock({
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
    return (
        <DocFindBlockUI
            filename={filename}
            query={query}
            totalMatches={totalMatches}
            isStreaming={isStreaming}
            showConnector={showConnector}
            onClick={onClick}
        />
    );
}

export function DocCreatedBlock({
    filename,
    showConnector,
    isStreaming,
    onClick,
}: {
    filename: string;
    showConnector?: boolean;
    isStreaming?: boolean;
    onClick?: () => void;
}) {
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor="green"
        >
            <div className="flex min-w-0 items-center gap-1.5">
                <EventLabel className="shrink-0">
                    {isStreaming ? "Creating" : "Created"}
                </EventLabel>
                {isStreaming || !onClick ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                        <FileTypeIcon
                            fileType={filename}
                            className="h-3.5 w-3.5"
                        />
                        <span className="truncate">
                            {isStreaming ? `${filename}...` : filename}
                        </span>
                    </span>
                ) : (
                    <button
                        type="button"
                        onClick={onClick}
                        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-gray-700"
                    >
                        <FileTypeIcon
                            fileType={filename}
                            className="h-3.5 w-3.5"
                        />
                        <span className="truncate">{filename}</span>
                    </button>
                )}
            </div>
        </EventBlock>
    );
}

export function DocReplicatedBlock({
    filename,
    count,
    copies,
    showConnector,
    isStreaming,
    hasError,
    onOpenCopy,
}: {
    filename: string;
    /**
     * How many consecutive replicates of this same source got collapsed
     * into this block. ≥ 1; only rendered when > 1.
     */
    count: number;
    copies?: {
        new_filename: string;
        document_id: string;
        version_id: string;
    }[];
    showConnector?: boolean;
    isStreaming?: boolean;
    hasError?: boolean;
    onOpenCopy?: (copy: {
        new_filename: string;
        document_id: string;
        version_id: string;
    }) => void;
}) {
    const label = isStreaming ? "Replicating" : "Replicated";
    const suffix =
        !isStreaming && count > 1
            ? ` ${count} times`
            : isStreaming
              ? "..."
              : "";
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={hasError ? "red" : "green"}
        >
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <EventLabel className="shrink-0">{label}</EventLabel>
                {!isStreaming && copies?.length ? (
                    copies.map((copy, index) => (
                        <span
                            key={copy.document_id}
                            className="flex min-w-0 items-center gap-1.5"
                        >
                            {index > 0 && <span aria-hidden="true">,</span>}
                            <FileTypeIcon
                                fileType={copy.new_filename}
                                className="h-3.5 w-3.5 shrink-0"
                            />
                            {onOpenCopy ? (
                                <button
                                    type="button"
                                    onClick={() => onOpenCopy(copy)}
                                    className="min-w-0 cursor-pointer truncate text-left transition-colors hover:text-gray-700"
                                >
                                    {copy.new_filename}
                                </button>
                            ) : (
                                <span className="truncate">
                                    {copy.new_filename}
                                </span>
                            )}
                        </span>
                    ))
                ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                        <FileTypeIcon
                            fileType={filename}
                            className="h-3.5 w-3.5 shrink-0"
                        />
                        <span className="truncate">{filename}</span>
                        {suffix ? <span className="shrink-0">{suffix}</span> : null}
                    </span>
                )}
            </div>
        </EventBlock>
    );
}

export function DocDownloadBlock({
    filename,
    download_url,
    onOpen,
    isReloading = false,
    versionNumber,
}: {
    filename: string;
    download_url: string;
    onOpen?: () => void;
    isReloading?: boolean;
    versionNumber?: number | null;
}) {
    const extMatch = filename.match(/\.(\w+)$/);
    const rawBasename = extMatch
        ? filename.slice(0, -extMatch[0].length)
        : filename;
    // Strip any legacy "[Edited V3]" suffix that may still be baked into
    // older saved download filenames — the version is surfaced as a
    // separate tag now.
    const basename = rawBasename.replace(/\s*\[Edited V\d+\]\s*$/, "").trim();
    // Only backend-relative URLs are accepted. Downloads stay on the
    // same-origin gateway so HttpOnly auth cookies are never sent elsewhere.
    const isSafeHref = download_url.startsWith("/");
    const href = isSafeHref ? `${API_BASE}${download_url}` : null;
    const [busy, setBusy] = useState(false);

    const handleDownload = async (e?: {
        stopPropagation?: () => void;
        preventDefault?: () => void;
    }) => {
        e?.stopPropagation?.();
        e?.preventDefault?.();
        if (busy || isReloading || !href) return;
        setBusy(true);
        try {
            const resp = await authenticatedFetch(href);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } finally {
            setBusy(false);
        }
    };

    const spinning = busy || isReloading;

    const body = (
        <div className="flex items-center gap-3 px-4 py-3 min-w-0 flex-1">
            <FileTypeIcon fileType={filename} className="h-4 w-4" />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <p className="text-lg font-serif text-gray-900 text-wrap">
                        {basename}
                    </p>
                    <VersionChip n={versionNumber} size="lg" />
                </div>
            </div>
        </div>
    );

    const downloadIcon = spinning ? (
        <div
            aria-disabled
            className="shrink-0 flex items-center bg-white/25 px-6 text-gray-400 cursor-not-allowed"
        >
            <Loader2 size={13} className="animate-spin" />
        </div>
    ) : (
        <button
            type="button"
            onClick={handleDownload}
            className="shrink-0 flex items-center bg-white/25 px-6 text-gray-500 transition-colors hover:bg-white/55 hover:text-gray-700 cursor-pointer"
        >
            <Download size={13} />
        </button>
    );

    if (onOpen) {
        return (
            <div
                className={`flex items-stretch overflow-hidden w-full font-serif ${RESPONSE_GLASS_SURFACE}`}
            >
                <button
                    type="button"
                    onClick={onOpen}
                    className="flex items-stretch flex-1 min-w-0 text-left transition-colors hover:bg-white/45 cursor-pointer"
                >
                    {body}
                </button>
                {downloadIcon}
            </div>
        );
    }

    if (spinning) {
        return (
            <div
                className={`flex items-stretch overflow-hidden w-full font-serif ${RESPONSE_GLASS_SURFACE}`}
            >
                {body}
                {downloadIcon}
            </div>
        );
    }

    return (
        <div
            className={`flex items-stretch overflow-hidden w-full font-serif ${RESPONSE_GLASS_SURFACE}`}
        >
            <button
                type="button"
                onClick={handleDownload}
                className="flex items-stretch flex-1 min-w-0 text-left transition-colors hover:bg-white/45 cursor-pointer"
            >
                {body}
            </button>
            {downloadIcon}
        </div>
    );
}

const RISK_BADGE_CLASS: Record<string, string> = {
    CRITICAL: "bg-red-100 text-red-800",
    HIGH: "bg-orange-100 text-orange-800",
    MEDIUM: "bg-amber-100 text-amber-800",
    LOW: "bg-green-100 text-green-800",
};

const RECOMMENDATION_LABEL: Record<string, string> = {
    READY_TO_SIGN: "Ready to sign",
    NEEDS_REVISIONS: "Needs revisions",
    ESCALATE_TO_CEO_COO: "Escalate to CEO/COO",
    DO_NOT_SIGN: "Do not sign",
};

export function ContractReviewStartBlock({
    filename,
    showConnector,
    isStreaming,
}: {
    filename: string;
    showConnector?: boolean;
    isStreaming?: boolean;
}) {
    return (
        <EventBlock showConnector={showConnector} isStreaming={isStreaming}>
            <div className="flex min-w-0 items-center gap-1.5">
                <EventLabel className="shrink-0">Reviewing contract</EventLabel>
                <FileTypeIcon fileType={filename} className="h-3.5 w-3.5" />
                <span className="truncate">{filename}</span>
            </div>
        </EventBlock>
    );
}

/**
 * Outcome of the review_contract tool. The chat gives the executive read;
 * triage, feedback, redlines and the memo live in the contracts workspace the
 * link points to.
 */
export function ContractReviewBlock({
    title,
    status,
    riskLevel,
    recommendation,
    workspacePath,
    error,
    showConnector,
}: {
    title: string;
    status: "ai_reviewed" | "failed";
    riskLevel: string | null;
    recommendation: string | null;
    workspacePath: string | null;
    error?: string;
    showConnector?: boolean;
}) {
    const failed = status === "failed";
    const badgeClass = riskLevel
        ? (RISK_BADGE_CLASS[riskLevel] ?? "bg-gray-100 text-gray-700")
        : null;
    return (
        <EventBlock
            showConnector={showConnector}
            dotColor={failed ? "red" : "green"}
        >
            <div
                className={`flex w-full min-w-0 items-center gap-3 px-3 py-2 font-sans ${RESPONSE_GLASS_SURFACE}`}
                data-testid="contract-review-card"
            >
                {failed ? (
                    <span className="shrink-0 rounded-md bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                        Review failed
                    </span>
                ) : (
                    riskLevel && (
                        <span
                            className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium ${badgeClass}`}
                        >
                            {riskLevel}
                        </span>
                    )
                )}
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-gray-900">
                        {title}
                    </div>
                    <div className="truncate text-xs text-gray-500">
                        {failed
                            ? (error ?? "The review could not be completed.")
                            : recommendation
                              ? (RECOMMENDATION_LABEL[recommendation] ??
                                recommendation)
                              : "Review stored"}
                    </div>
                </div>
                {workspacePath && (
                    <a
                        href={workspacePath}
                        className="shrink-0 text-xs font-medium text-blue-700 hover:text-blue-900 whitespace-nowrap"
                    >
                        Open review workspace →
                    </a>
                )}
            </div>
        </EventBlock>
    );
}

export function WorkflowAppliedBlock({
    title,
    showConnector,
    onClick,
}: {
    title: string;
    showConnector?: boolean;
    onClick?: () => void;
}) {
    return (
        <EventBlock showConnector={showConnector} dotColor="green">
            <div className="flex min-w-0 items-center gap-1.5">
                <EventLabel className="shrink-0">Read</EventLabel>
                {onClick ? (
                    <button
                        type="button"
                        onClick={onClick}
                        aria-label={`Open workflow ${title}`}
                        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-gray-700"
                    >
                        <WorkflowSkeuoIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{title}</span>
                    </button>
                ) : (
                    <span className="flex min-w-0 items-center gap-1.5">
                        <WorkflowSkeuoIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{title}</span>
                    </span>
                )}
            </div>
        </EventBlock>
    );
}

export function AskInputsBlock({
    event,
    response,
    showConnector,
}: {
    event: Extract<AssistantEvent, { type: "ask_inputs" }>;
    response?: Extract<AssistantEvent, { type: "ask_inputs_response" }>;
    showConnector?: boolean;
}) {
    const [isOpen, setIsOpen] = useState(!response);
    const responseById = new Map(
        response?.responses.map((item) => [item.id, item]) ?? [],
    );
    return (
        <EventBlock
            showConnector={showConnector}
            dotColor={response ? "green" : "gray"}
        >
            <EventDisclosureButton
                open={isOpen}
                onToggle={() => setIsOpen((open) => !open)}
                label={response ? "Asked for input" : "Asking for input"}
            />
            {isOpen && (
                <div className="mt-2 space-y-2 text-gray-800">
                    {event.items.map((item, index) => {
                        const itemResponse = responseById.get(item.id);
                        const responseText = (() => {
                            if (!itemResponse) return null;
                            if (itemResponse.skipped) return "Skipped";
                            if (itemResponse.kind === "multi_choice") {
                                return itemResponse.answers?.join(", ") ?? "";
                            }
                            if (itemResponse.kind !== "documents") {
                                return itemResponse.answer ?? "";
                            }
                            const filenames = itemResponse.filenames;
                            return filenames.length
                                ? filenames.join(", ")
                                : "No documents attached";
                        })();
                        return (
                            <div key={item.id}>
                                <p className="text-xs text-gray-500">
                                    {index + 1}.{" "}
                                    {item.kind === "documents"
                                        ? "Documents"
                                        : "Question"}
                                </p>
                                <p className="mt-0.5">
                                    {item.kind === "documents"
                                        ? item.document_types.join(", ") ||
                                          "Documents requested"
                                        : item.question}
                                </p>
                                {responseText !== null && (
                                    <p className="mt-0.5 text-gray-600">
                                        {responseText}
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </EventBlock>
    );
}

export type CourtListenerBlockItem = {
    caseName: string | null;
    citation: string | null;
    dateFiled?: string | null;
    url?: string | null;
    query?: string;
    totalMatches?: number;
    hasError?: boolean;
};

export function CourtListenerBlock({
    label,
    detail,
    isStreaming,
    hasError,
    showConnector,
    items,
}: {
    label: string;
    detail?: string;
    isStreaming?: boolean;
    hasError?: boolean;
    showConnector?: boolean;
    items?: CourtListenerBlockItem[];
}) {
    const [isOpen, setIsOpen] = useState(false);
    const hasItems = !!items && items.length > 0;
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={hasError ? "red" : "green"}
        >
            {hasItems ? (
                <EventDisclosureButton
                    open={isOpen}
                    onToggle={() => setIsOpen((v) => !v)}
                    label={label}
                    detail={detail}
                    isStreaming={isStreaming}
                />
            ) : (
                <>
                    <EventLabel>{label}</EventLabel>
                    {detail ? <span>&nbsp;{detail}</span> : null}
                    {isStreaming ? <span>...</span> : null}
                </>
            )}
            {isOpen && hasItems && (
                <ul className="mt-2 flex flex-col gap-1 text-sm font-serif text-gray-500">
                    {items!.map((item, idx) => {
                        const label = [item.caseName, item.citation]
                            .filter(Boolean)
                            .join(", ");
                        const primary = label || item.url || "Unknown case";
                        const searchText = item.query
                            ? `Searched for "${item.query}" in ${primary}${
                                  typeof item.totalMatches === "number"
                                      ? ` (${item.totalMatches} ${
                                            item.totalMatches === 1
                                                ? "match"
                                                : "matches"
                                        })`
                                      : ""
                              }`
                            : null;
                        return (
                            <li key={idx}>
                                <div
                                    className={
                                        item.hasError ? "text-red-500" : ""
                                    }
                                >
                                    {item.url ? (
                                        <a
                                            href={item.url}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="hover:text-gray-700 hover:underline underline-offset-2"
                                        >
                                            {searchText ?? primary}
                                        </a>
                                    ) : searchText ? (
                                        <span>{searchText}</span>
                                    ) : (
                                        <span>{primary}</span>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </EventBlock>
    );
}

export function DocEditBlock({
    filename,
    showConnector,
    isStreaming,
    hasError,
    onClick,
}: {
    filename: string;
    showConnector?: boolean;
    isStreaming?: boolean;
    hasError?: boolean;
    onClick?: () => void;
}) {
    const label = isStreaming ? "Editing" : hasError ? "Edit failed" : "Edited";

    return (
        <DocEditBlockUI
            label={label}
            filename={filename}
            fileIcon={
                <FileTypeIcon fileType={filename} className="h-3.5 w-3.5" />
            }
            onClick={onClick}
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={hasError ? "red" : "green"}
        />
    );
}
