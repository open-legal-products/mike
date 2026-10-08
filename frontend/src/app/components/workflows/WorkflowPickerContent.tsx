"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { SearchBar } from "@/app/components/ui/search-bar";
import {
    ChatSkeuoIcon,
    TabularReviewSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ColumnConfig, Workflow } from "../shared/types";
import {
    formatIcon,
    formatIconClassName,
    formatLabel,
} from "../tabular/columnFormat";
import { TAG_COLORS } from "../tabular/pillUtils";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
    LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS,
} from "@/app/components/ui/liquid-surface";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@/shared/ui/LiquidGlassUI";

type WorkflowPreviewMode = "auto" | "prompt" | "columns";
type MobilePickerPane = "list" | "details";

interface WorkflowPickerContentProps {
    workflows: Workflow[];
    selected: Workflow | null;
    onSelect: (workflow: Workflow | null) => void;
    search: string;
    onSearchChange: (value: string) => void;
    loading?: boolean;
    previewLoading?: boolean;
    workflowType?: Workflow["metadata"]["type"] | "all";
    emptyMessage?: string;
    previewMode?: WorkflowPreviewMode;
    disabledWorkflow?: (workflow: Workflow) => boolean;
    showTypeIcon?: boolean;
    allowClearPreview?: boolean;
}

export function WorkflowPickerContent({
    workflows,
    selected,
    onSelect,
    search,
    onSearchChange,
    loading = false,
    previewLoading = false,
    workflowType = "all",
    emptyMessage,
    previewMode = "auto",
    disabledWorkflow,
    showTypeIcon = false,
    allowClearPreview = true,
}: WorkflowPickerContentProps) {
    const selectedRowRef = useRef<HTMLButtonElement>(null);
    const selectedId = selected?.id ?? null;
    const [mobilePaneState, setMobilePaneState] = useState<{
        selectedId: string | null;
        pane: MobilePickerPane;
    }>({
        selectedId,
        pane: selected ? "details" : "list",
    });
    const mobilePane =
        mobilePaneState.selectedId === selectedId
            ? mobilePaneState.pane
            : selected
              ? "details"
              : "list";
    const setMobilePane = (pane: MobilePickerPane) => {
        setMobilePaneState({ selectedId, pane });
    };

    useEffect(() => {
        if (selectedRowRef.current) {
            selectedRowRef.current.scrollIntoView({ block: "nearest" });
        }
    }, [selected?.id]);

    const normalizedSearch = search.trim().toLowerCase();
    const filteredWorkflows = normalizedSearch
        ? workflows.filter((workflow) =>
              [
                  workflow.metadata.title,
                  workflow.metadata.practice ?? "",
              ]
                  .join(" ")
                  .toLowerCase()
                  .includes(normalizedSearch),
          )
        : workflows;
    const resolvedEmptyMessage =
        emptyMessage ??
        (search
            ? "No matches found"
            : workflowType === "all"
              ? "No workflows found"
              : `No ${workflowType} workflows found`);
    const handleSelectWorkflow = (workflow: Workflow | null) => {
        onSelect(workflow);
        setMobilePane(workflow ? "details" : "list");
    };
    const handleClearPreview = () => {
        onSelect(null);
        setMobilePane("list");
    };

    return (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-visible md:flex-row">
            <div
                className={`min-h-0 min-w-0 flex-1 flex-col overflow-visible ${
                    selected ? "md:w-64 md:flex-none md:shrink-0" : ""
                } ${mobilePane === "details" && selected ? "hidden md:flex" : "flex"}`}
            >
                <SearchBar
                    value={search}
                    onValueChange={onSearchChange}
                    placeholder="Search workflows..."
                />

                <div
                    data-slot="workflow-picker-list"
                    className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto rounded-sm px-1 pt-2"
                >
                    {loading ? (
                        <div className="space-y-px">
                            {[60, 45, 75, 50, 65, 40, 55].map(
                                (width, index) => (
                                    <div
                                        key={index}
                                        className="flex items-center justify-between gap-3 rounded-md px-3 py-2.5"
                                    >
                                        <div
                                            className="h-3 animate-pulse rounded bg-gray-100"
                                            style={{ width: `${width}%` }}
                                        />
                                        <div className="h-3 w-10 shrink-0 animate-pulse rounded bg-gray-100" />
                                    </div>
                                ),
                            )}
                        </div>
                    ) : filteredWorkflows.length === 0 ? (
                        <p className="py-8 text-center text-sm text-gray-400">
                            {resolvedEmptyMessage}
                        </p>
                    ) : (
                        <div className="space-y-px">
                            {filteredWorkflows.map((workflow) => {
                                const disabled =
                                    disabledWorkflow?.(workflow) ?? false;
                                const isSelected = selected?.id === workflow.id;
                                const TypeIcon =
                                    workflow.metadata.type === "tabular"
                                        ? TabularReviewSkeuoIcon
                                        : ChatSkeuoIcon;
                                return (
                                    <button
                                        key={workflow.id}
                                        ref={isSelected ? selectedRowRef : null}
                                        type="button"
                                        disabled={disabled}
                                        onClick={() =>
                                            handleSelectWorkflow(
                                                isSelected ? null : workflow,
                                            )
                                        }
                                        className={`flex min-w-0 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-xs transition-all ${
                                            isSelected
                                                ? `${LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS} text-gray-900`
                                                : LIQUID_GLASS_MODAL_ROW_HOVER_CLASS
                                        } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
                                    >
                                        <span
                                            className={`min-w-0 flex-1 truncate ${
                                                isSelected
                                                    ? "font-medium text-gray-900"
                                                    : "text-gray-700"
                                            }`}
                                        >
                                            {workflow.metadata.title}
                                        </span>
                                        {showTypeIcon ? (
                                            <TypeIcon className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                                        ) : !selected &&
                                          workflow.metadata.practice ? (
                                            <span className="shrink-0 text-xs text-gray-400">
                                                {workflow.metadata.practice}
                                            </span>
                                        ) : null}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {selected && (
                <WorkflowPreview
                    workflow={selected}
                    mode={previewMode}
                    onClear={handleClearPreview}
                    allowClear={allowClearPreview}
                    loading={previewLoading}
                    className={
                        mobilePane === "details" ? "flex" : "hidden md:flex"
                    }
                />
            )}
        </div>
    );
}

function WorkflowPreview({
    workflow,
    mode,
    onClear,
    allowClear,
    loading,
    className = "flex",
}: {
    workflow: Workflow;
    mode: WorkflowPreviewMode;
    onClear: () => void;
    allowClear: boolean;
    loading: boolean;
    className?: string;
}) {
    const resolvedMode =
        mode === "auto"
            ? workflow.metadata.type === "tabular"
                ? "columns"
                : "prompt"
            : mode;
    return (
        <div
            className={`${className} min-h-0 min-w-0 flex-1 flex-col overflow-visible`}
        >
            <div
                className={`flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl p-1 ${LIQUID_GLASS_SUBTLE_CLASS}`}
            >
                <div className="flex h-9 shrink-0 items-center justify-between px-3">
                    <p className="min-w-0 flex-1 truncate text-xs font-medium text-gray-700">
                        {workflow.metadata.title}
                    </p>
                    {allowClear ? (
                        <button
                            type="button"
                            onClick={onClear}
                            className={`rounded-md p-1 text-gray-400 transition-colors hover:text-gray-600 ${LIQUID_GLASS_HOVER_CLASS}`}
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    ) : null}
                </div>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
                    {loading ? (
                        <WorkflowPreviewSkeleton mode={resolvedMode} />
                    ) : resolvedMode === "columns" ? (
                        <WorkflowColumnPreview
                            columns={workflow.columns_config ?? []}
                        />
                    ) : (
                        <WorkflowPromptPreview
                            content={
                                workflow.skill_md ?? "_No prompt defined._"
                            }
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

function WorkflowPreviewSkeleton({ mode }: { mode: "prompt" | "columns" }) {
    return (
        <div
            role="status"
            aria-label={`Loading workflow ${mode}`}
            className="min-w-0 flex-1 space-y-3 px-3 py-3"
        >
            {(mode === "columns"
                ? ["w-3/4", "w-2/3", "w-4/5", "w-1/2"]
                : ["w-full", "w-11/12", "w-4/5", "w-full", "w-2/3"]
            ).map((width, index) => (
                <div
                    key={index}
                    className={`h-3 animate-pulse rounded bg-gray-100 ${width}`}
                />
            ))}
        </div>
    );
}

function WorkflowPromptPreview({ content }: { content: string }) {
    const previewContent = stripLeadingMarkdownHeading(content);

    return (
        <div className="min-w-0 flex-1 break-words rounded-md px-3 py-3 text-xs leading-relaxed text-gray-600">
            <WorkflowPromptMarkdown content={previewContent} />
        </div>
    );
}

function stripLeadingMarkdownHeading(content: string) {
    const stripped = content.replace(/^\s{0,3}#{1,6}\s+[^\n]+(?:\n+|$)/, "");
    return stripped.trimStart() || content;
}

function WorkflowPromptMarkdown({ content }: { content: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                h1: ({ children }) => (
                    <h1 className="mb-1 mt-4 text-sm font-semibold text-gray-900 first:mt-0">
                        {children}
                    </h1>
                ),
                h2: ({ children }) => (
                    <h2 className="mb-1 mt-3 text-xs font-semibold text-gray-900 first:mt-0">
                        {children}
                    </h2>
                ),
                h3: ({ children }) => (
                    <h3 className="mb-0.5 mt-2 text-[11px] font-semibold text-gray-900 first:mt-0">
                        {children}
                    </h3>
                ),
                p: ({ children }) => (
                    <p className="mb-2 last:mb-0">{children}</p>
                ),
                ul: ({ children }) => (
                    <ul className="mb-2 list-disc space-y-0.5 pl-4">
                        {children}
                    </ul>
                ),
                ol: ({ children }) => (
                    <ol className="mb-2 list-decimal space-y-0.5 pl-4">
                        {children}
                    </ol>
                ),
                li: ({ children }) => <li>{children}</li>,
                table: ({ children }) => (
                    <div className="my-3 overflow-x-auto rounded-md border border-gray-200 first:mt-0 last:mb-0">
                        <table className="min-w-full border-collapse text-left text-[11px]">
                            {children}
                        </table>
                    </div>
                ),
                thead: ({ children }) => (
                    <thead className="bg-gray-50">{children}</thead>
                ),
                tbody: ({ children }) => (
                    <tbody className="divide-y divide-gray-100">
                        {children}
                    </tbody>
                ),
                tr: ({ children }) => (
                    <tr className="divide-x divide-gray-100">{children}</tr>
                ),
                th: ({ children }) => (
                    <th className="px-3 py-2 font-medium text-gray-700">
                        {children}
                    </th>
                ),
                td: ({ children }) => (
                    <td className="px-3 py-2 align-top text-gray-600">
                        {children}
                    </td>
                ),
                strong: ({ children }) => (
                    <strong className="font-semibold text-gray-800">
                        {children}
                    </strong>
                ),
                em: ({ children }) => <em className="italic">{children}</em>,
            }}
        >
            {content}
        </ReactMarkdown>
    );
}

function WorkflowColumnPreview({ columns }: { columns: ColumnConfig[] }) {
    const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
    const sortedColumns = [...columns].sort((a, b) => a.index - b.index);
    return (
        <div className="min-w-0 flex-1 space-y-px rounded-sm">
            {sortedColumns.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-gray-400">
                    No columns defined
                </p>
            ) : (
                sortedColumns.map((column) => {
                    const isExpanded = expandedIndex === column.index;
                    const FormatIcon = formatIcon(column.format ?? "text");
                    return (
                        <div key={column.index} className="rounded-md">
                            <button
                                type="button"
                                onClick={() =>
                                    setExpandedIndex(
                                        isExpanded ? null : column.index,
                                    )
                                }
                                className={`flex min-w-0 w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-xs transition-all ${
                                    isExpanded
                                        ? LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS
                                        : LIQUID_GLASS_MODAL_ROW_HOVER_CLASS
                                }`}
                            >
                                <FormatIcon
                                    className={`h-3.5 w-3.5 shrink-0 ${formatIconClassName(column.format ?? "text")}`}
                                />
                                <span className="min-w-0 flex-1 truncate text-gray-800">
                                    {column.name}
                                </span>
                                <span className="max-w-24 shrink-0 truncate text-gray-400">
                                    {formatLabel(column.format ?? "text")}
                                </span>
                                <ChevronDown
                                    className={`h-3 w-3 shrink-0 text-gray-300 transition-transform duration-150 ${isExpanded ? "rotate-180" : ""}`}
                                />
                            </button>
                            {isExpanded ? (
                                <div className="mt-1 min-w-0 space-y-3 break-words rounded-md bg-white/60 px-4 py-3 text-xs leading-relaxed text-gray-600">
                                    {column.tags && column.tags.length > 0 ? (
                                        <div>
                                            <p className="mb-1.5 text-[11px] font-medium text-gray-600">
                                                Tags
                                            </p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {column.tags.map(
                                                    (tag, tagIdx) => (
                                                        <span
                                                            key={tag}
                                                            className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] ${TAG_COLORS[tagIdx % TAG_COLORS.length]}`}
                                                        >
                                                            {tag}
                                                        </span>
                                                    ),
                                                )}
                                            </div>
                                        </div>
                                    ) : null}
                                    <div>
                                        <p className="mb-1 text-[11px] font-medium text-gray-600">
                                            Prompt
                                        </p>
                                        <WorkflowPromptMarkdown
                                            content={
                                                column.prompt ||
                                                "_No prompt defined._"
                                            }
                                        />
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    );
                })
            )}
        </div>
    );
}
