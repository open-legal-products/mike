"use client";

import {
    Download,
    FileDown,
    FileText,
    ImagePlus,
    Loader2,
    type LucideIcon,
} from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "./dropdown";
import { TextButtonUI } from "./TextButtonUI";

export type VisualExportItem = "html" | "pdf" | "docx" | "insert";

export type VisualExportMenuUIProps = {
    onDownloadHtml?: () => void;
    onDownloadPdf?: () => void;
    onCreateDocx?: () => void;
    onInsert?: () => void;
    busyItem?: VisualExportItem | null;
    disabled?: boolean;
};

const ITEMS: { id: VisualExportItem; label: string; icon: LucideIcon }[] = [
    { id: "html", label: "Download HTML", icon: Download },
    { id: "pdf", label: "Download PDF", icon: FileDown },
    { id: "docx", label: "New Word document", icon: FileText },
    { id: "insert", label: "Insert into document", icon: ImagePlus },
];

function Working() {
    return (
        <Loader2
            aria-label="Working"
            role="img"
            className="ml-auto h-3.5 w-3.5 animate-spin"
        />
    );
}

export function VisualExportMenuUI({
    onDownloadHtml,
    onDownloadPdf,
    onCreateDocx,
    onInsert,
    busyItem = null,
    disabled = false,
}: VisualExportMenuUIProps) {
    const handlers: Record<VisualExportItem, (() => void) | undefined> = {
        html: onDownloadHtml,
        pdf: onDownloadPdf,
        docx: onCreateDocx,
        insert: onInsert,
    };
    const items = ITEMS.filter((item) => handlers[item.id]);
    const only = items.length === 1 ? items[0] : undefined;

    if (only) {
        return (
            <TextButtonUI
                size="xs"
                disabled={disabled || busyItem !== null}
                aria-busy={busyItem ? true : undefined}
                onClick={() => handlers[only.id]?.()}
            >
                {busyItem === only.id ? (
                    <Working />
                ) : (
                    <only.icon aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {only.label}
            </TextButtonUI>
        );
    }

    return (
        <Dropdown modal={false}>
            <DropdownTrigger asChild>
                <TextButtonUI
                    size="icon-xs"
                    aria-label="Export visual"
                    title="Export visual"
                    disabled={disabled}
                    aria-busy={busyItem ? true : undefined}
                >
                    <Download aria-hidden="true" className="h-3.5 w-3.5" />
                </TextButtonUI>
            </DropdownTrigger>
            <DropdownContent align="end">
                {items.map((item) => (
                    <DropdownItem
                        key={item.id}
                        disabled={busyItem !== null}
                        onSelect={() => handlers[item.id]?.()}
                    >
                        {item.label}
                        {busyItem === item.id && <Working />}
                    </DropdownItem>
                ))}
            </DropdownContent>
        </Dropdown>
    );
}
