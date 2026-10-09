"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { listDocumentVersions, type DocumentVersion } from "@/app/lib/mikeApi";
import {
    Dropdown,
    DropdownContent,
    DropdownRadioGroup,
    DropdownRadioItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { VersionChip } from "./VersionChip";

export function DocumentVersionPicker({
    documentId,
    versionId,
    versionNumber,
    disabled,
    onSelect,
}: {
    documentId: string;
    versionId?: string | null;
    versionNumber?: number | null;
    disabled?: boolean;
    onSelect: (version: DocumentVersion) => void;
}) {
    const [open, setOpen] = useState(false);
    const [result, setResult] = useState<Awaited<
        ReturnType<typeof listDocumentVersions>
    > | null>(null);
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        let cancelled = false;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- load the version count for the displayed document
        setResult(null);
        setError(false);
        void listDocumentVersions(documentId)
            .then((value) => {
                if (!cancelled) setResult(value);
            })
            .catch(() => {
                if (!cancelled) setError(true);
            });
        return () => {
            cancelled = true;
        };
    }, [documentId, versionId, retry]);
    const selectedId = versionId ?? result?.current_version_id ?? "";
    const versions = result?.versions
        .filter((version) => !version.deleted_at)
        .sort((a, b) => (b.version_number ?? 0) - (a.version_number ?? 0));
    const displayedNumber =
        versionNumber ??
        versions?.find((version) => version.id === selectedId)?.version_number;
    const label = displayedNumber ? (
        <VersionChip n={displayedNumber} />
    ) : (
        <span className="text-[10px]">Version</span>
    );
    if (error)
        return (
            <TextButtonUI
                size="xs"
                className="h-auto p-0.5"
                aria-label="Retry loading document versions"
                title="Could not load versions. Click to retry."
                onClick={() => setRetry((value) => value + 1)}
            >
                {label}
            </TextButtonUI>
        );
    // Avoid showing a nonfunctional chevron while the count is loading or
    // when there is only one available version (deleted versions do not count).
    if (!versions || versions.length <= 1) return label;
    return (
        <Dropdown
            open={open}
            onOpenChange={(nextOpen) => {
                if (!disabled || !nextOpen) setOpen(nextOpen);
            }}
        >
            <DropdownTrigger asChild disabled={disabled}>
                <TextButtonUI
                    size="xs"
                    disabled={disabled}
                    className="h-auto gap-0.5 p-0.5"
                    aria-label={
                        displayedNumber
                            ? `Choose document version, currently V${displayedNumber}`
                            : "Choose document version"
                    }
                    title={
                        disabled
                            ? "Save changes before switching versions"
                            : "Choose document version"
                    }
                >
                    {label}
                    <ChevronDown aria-hidden="true" className="h-3 w-3" />
                </TextButtonUI>
            </DropdownTrigger>
            <DropdownContent align="start">
                <DropdownRadioGroup
                    value={selectedId}
                    onValueChange={(id) => {
                        const version = versions.find((item) => item.id === id);
                        if (version && id !== selectedId && !disabled)
                            onSelect(version);
                    }}
                >
                    {versions.map((version) => (
                        <DropdownRadioItem
                            key={version.id}
                            value={version.id}
                            disabled={disabled}
                        >
                            {version.version_number
                                ? `V${version.version_number}`
                                : "Version"}
                            {version.filename && (
                                <span className="max-w-48 truncate">
                                    {version.filename}
                                </span>
                            )}
                            {version.id === result?.current_version_id && (
                                <span className="text-muted-foreground">
                                    Current
                                </span>
                            )}
                        </DropdownRadioItem>
                    ))}
                </DropdownRadioGroup>
            </DropdownContent>
        </Dropdown>
    );
}
