"use client";

import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ColumnConfig } from "../shared/types";
import {
    formatIcon,
    formatIconClassName,
    formatLabel,
} from "../tabular/columnFormat";
import { Modal } from "../modals/Modal";
import { FieldLabel } from "../ui/form-field";

interface Props {
    col: ColumnConfig;
    onClose: () => void;
}

export function WFColumnViewModal({ col, onClose }: Props) {
    const formatIconElement = createElement(formatIcon(col.format ?? "text"), {
        className: `h-3.5 w-3.5 ${formatIconClassName(col.format ?? "text")}`,
    });
    return (
        <Modal
            open
            onClose={onClose}
            breadcrumbs={["Workflows", col.name]}
            primaryAction={{
                label: "Close",
                onClick: onClose,
            }}
            cancelAction={false}
        >
            <div data-modal-scroll="vertical" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
                <div>
                    <FieldLabel as="p">Column Title</FieldLabel>
                    <p className="text-sm text-gray-800">{col.name}</p>
                </div>
                <div>
                    <FieldLabel as="p">Format</FieldLabel>
                    <span className="inline-flex items-center gap-1.5 text-sm text-gray-700">
                        {formatIconElement}
                        {formatLabel(col.format ?? "text")}
                    </span>
                </div>
                {col.tags && col.tags.length > 0 && (
                    <div>
                        <FieldLabel as="p">Tags</FieldLabel>
                        <div className="flex flex-wrap gap-1.5">
                            {col.tags.map((tag) => (
                                <span key={tag} className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{tag}</span>
                            ))}
                        </div>
                    </div>
                )}
                <div>
                    <FieldLabel as="p">Prompt</FieldLabel>
                    <div className="text-base text-gray-700 leading-relaxed font-serif prose prose-base max-w-none">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{col.prompt || "_No prompt defined._"}</ReactMarkdown>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
