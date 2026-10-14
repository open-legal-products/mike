import { File } from "lucide-react";
import { SvgAssetIcon } from "@/app/components/ui/svg-asset-icon";
import pdf from "../../../../public/icons/file-types/pdf.svg";
import word from "../../../../public/icons/file-types/word.svg";
import excel from "../../../../public/icons/file-types/excel.svg";
import ppt from "../../../../public/icons/file-types/ppt.svg";

const icons = { pdf, word, excel, ppt };

export type FileTypeKind = "pdf" | "word" | "excel" | "ppt" | "other";

/**
 * Normalize a file_type value (e.g. "pdf") or a filename (e.g. "deck.pptx")
 * into a coarse kind used to pick an icon. Accepts both because some call
 * sites only have the filename (user-message files, citations) while others
 * carry the document's `file_type` field.
 */
export function fileTypeKind(value: string | null | undefined): FileTypeKind {
    const raw = (value ?? "").toLowerCase().trim();
    const ext = raw.includes(".") ? (raw.split(".").pop() ?? "") : raw;
    if (ext === "pdf") return "pdf";
    if (ext === "docx" || ext === "doc") return "word";
    if (ext === "xlsx" || ext === "xlsm" || ext === "xls") return "excel";
    if (ext === "pptx" || ext === "ppt") return "ppt";
    return "other";
}

/**
 * Canonical document file-type icon. Size and any extra classes come from
 * `className`; `shrink-0` is always applied. `muted` renders a neutral grey
 * placeholder (used for loading/disabled rows).
 */
export function FileTypeIcon({
    fileType,
    className = "h-3.5 w-3.5",
    muted = false,
}: {
    fileType: string | null | undefined;
    className?: string;
    muted?: boolean;
}) {
    const cls = `${className} shrink-0`;
    const kind = fileTypeKind(fileType);
    if (kind === "other")
        return <File className={`${cls} ${muted ? "text-gray-300" : "text-gray-500"}`} />;
    return (
        <SvgAssetIcon
            src={icons[kind]}
            className={`${cls}${muted ? " grayscale opacity-35" : ""}`}
        />
    );
}
