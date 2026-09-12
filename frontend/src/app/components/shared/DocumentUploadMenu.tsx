"use client";

import { Files, FolderUp, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { HeaderButtonUI } from "@/shared/ui/HeaderButtonsUI";

interface DocumentUploadMenuProps {
    onSavedFiles?: (() => void) | null;
    onUploadFiles: (() => void) | null;
    onUploadFolder?: (() => void) | null;
    disabled?: boolean;
}

export function DocumentUploadMenu({
    onSavedFiles,
    onUploadFiles,
    onUploadFolder,
    disabled = false,
}: DocumentUploadMenuProps) {
    const t = useTranslations("documentosMenu");
    const triggerDisabled =
        disabled || (!onSavedFiles && !onUploadFiles && !onUploadFolder);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <HeaderButtonUI
                    disabled={triggerDisabled}
                    title={t("upload")}
                    aria-label={t("upload")}
                    iconOnly
                >
                    <Upload className="h-3.5 w-3.5" />
                </HeaderButtonUI>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                align="end"
                className="z-[160] min-w-40 p-1"
            >
                {onSavedFiles !== undefined && (
                    <LiquidDropdownItem
                        disabled={disabled || !onSavedFiles}
                        onSelect={() => onSavedFiles?.()}
                        className="flex items-center px-3 py-2"
                    >
                        <Files className="mr-2 h-3.5 w-3.5" />
                        {t("arquivosSalvos")}
                    </LiquidDropdownItem>
                )}
                <LiquidDropdownItem
                    disabled={disabled || !onUploadFiles}
                    onSelect={() => onUploadFiles?.()}
                    className="flex items-center px-3 py-2"
                >
                    <Upload className="mr-2 h-3.5 w-3.5" />
                    {t("enviarArquivos")}
                </LiquidDropdownItem>
                {onUploadFolder !== undefined && (
                    <LiquidDropdownItem
                        disabled={disabled || !onUploadFolder}
                        onSelect={() => onUploadFolder?.()}
                        className="flex items-center px-3 py-2"
                    >
                        <FolderUp className="mr-2 h-3.5 w-3.5" />
                        {t("enviarPasta")}
                    </LiquidDropdownItem>
                )}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}
