"use client";

import { useState } from "react";
import { MessageSquare, TextQuote, Waypoints } from "lucide-react";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import type { MessageFile } from "../shared/types";
import { LIQUID_GLASS_FLAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import {
    parseExcerpts,
    type MessageExcerpt,
} from "@/app/lib/messageExcerpts";
import { ExcerptModal } from "./ExcerptModal";

interface Props {
    content: string;
    files?: MessageFile[];
    workflow?: { id: string; title: string };
    onFileClick?: (file: MessageFile) => void;
    /** Reveals the workflow this message ran, in the workflow modal. */
    onWorkflowClick?: (workflow: { id: string; title: string }) => void;
}

export function UserMessage({
    content,
    files,
    workflow,
    onFileClick,
    onWorkflowClick,
}: Props) {
    const hasFiles = files && files.length > 0;
    // Passages quoted from an earlier response travel as leading blockquotes;
    // here they are pills that open the passage, as in the composer.
    const { excerpts, body } = parseExcerpts(content);
    const [openExcerpt, setOpenExcerpt] = useState<MessageExcerpt | null>(
        null,
    );

    return (
        <div className="w-full flex justify-end">
            <div className="max-w-[80%] bg-gray-100 rounded-xl px-4 py-3">
                {body && (
                    <p className="text-sm text-gray-900 whitespace-pre-wrap">
                        {body}
                    </p>
                )}
                {(workflow || hasFiles || excerpts.length > 0) && (
                    <div
                        className={`flex flex-wrap justify-end gap-1.5 ${body ? "mt-3" : ""}`}
                    >
                        {excerpts.map((excerpt, i) => (
                            <button
                                key={`excerpt-${i}`}
                                type="button"
                                onClick={() => setOpenExcerpt(excerpt)}
                                aria-label={`View excerpt: ${excerpt.text.slice(0, 60)}`}
                                className={`inline-flex cursor-pointer items-center gap-1 rounded-[10px] py-0.5 pl-2 pr-2.5 text-xs text-gray-800 transition-colors hover:bg-white/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${LIQUID_GLASS_FLAT_CLASS}`}
                            >
                                {excerpt.note ? (
                                    <MessageSquare
                                        aria-hidden="true"
                                        className="h-2.5 w-2.5 shrink-0"
                                    />
                                ) : (
                                    <TextQuote
                                        aria-hidden="true"
                                        className="h-2.5 w-2.5 shrink-0"
                                    />
                                )}
                                {excerpt.note ? "Annotated Excerpt" : "Excerpt"}
                            </button>
                        ))}
                        {workflow && (
                            <div className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs bg-blue-600 text-white shadow border border-blue-600">
                                {onWorkflowClick ? (
                                    <button
                                        type="button"
                                        onClick={() => onWorkflowClick(workflow)}
                                        aria-label={`Open workflow ${workflow.title}`}
                                        className="inline-flex min-w-0 items-center gap-1 rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                    >
                                        <Waypoints className="h-2.5 w-2.5 shrink-0" />
                                        <span className="max-w-[140px] truncate">
                                            {workflow.title}
                                        </span>
                                    </button>
                                ) : (
                                    <>
                                        <Waypoints className="h-2.5 w-2.5 shrink-0" />
                                        <span className="max-w-[140px] truncate">
                                            {workflow.title}
                                        </span>
                                    </>
                                )}
                            </div>
                        )}
                        {hasFiles &&
                            files.map((f, i) => {
                                const className =
                                    `inline-flex items-center gap-1 rounded-[10px] py-0.5 pl-2 pr-2.5 text-xs text-gray-800 ${LIQUID_GLASS_FLAT_CLASS}`;
                                const fileContent = (
                                    <>
                                        <FileTypeIcon
                                            fileType={f.filename}
                                            className="h-2.5 w-2.5"
                                        />
                                        <span className="max-w-[140px] truncate">
                                            {f.filename}
                                        </span>
                                    </>
                                );
                                return f.document_id && onFileClick ? (
                                    <button
                                        key={i}
                                        type="button"
                                        onClick={() => onFileClick(f)}
                                        aria-label={`Open ${f.filename}`}
                                        className={`${className} cursor-pointer transition-colors hover:bg-white/80`}
                                    >
                                        {fileContent}
                                    </button>
                                ) : (
                                    <div key={i} className={className}>
                                        {fileContent}
                                    </div>
                                );
                            })}
                    </div>
                )}
            </div>
            <ExcerptModal
                excerpt={openExcerpt}
                onClose={() => setOpenExcerpt(null)}
            />
        </div>
    );
}
