"use client";

import { Library } from "lucide-react";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import type { MessageFile } from "../shared/types";
import { LIQUID_GLASS_FLAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { QuotedMessageContent } from "../shared/QuotedMessageContent";

interface Props {
    content: string;
    files?: MessageFile[];
    workflow?: { id: string; title: string };
    onFileClick?: (file: MessageFile) => void;
}

export function UserMessage({ content, files, workflow, onFileClick }: Props) {
    const hasFiles = files && files.length > 0;

    return (
        <div className="w-full flex justify-end">
            <div className="max-w-[80%] bg-gray-100 rounded-xl px-4 py-3">
                <QuotedMessageContent
                    content={content}
                    className="text-sm text-gray-900"
                />
                {(workflow || hasFiles) && (
                    <div className="flex flex-wrap justify-end gap-1.5 mt-3">
                        {workflow && (
                            <div className="inline-flex items-center gap-1 pl-2 pr-2.5 py-0.5 rounded-full text-xs bg-blue-600 text-white shadow border border-blue-600">
                                <Library className="h-2.5 w-2.5 shrink-0" />
                                <span className="max-w-[140px] truncate">{workflow.title}</span>
                            </div>
                        )}
                        {hasFiles &&
                            files.map((f, i) => {
                                const className =
                                    `inline-flex items-center gap-1 rounded-[10px] py-0.5 pl-2 pr-2.5 text-xs text-gray-800 ${LIQUID_GLASS_FLAT_CLASS} backdrop-blur-xl`;
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
        </div>
    );
}
