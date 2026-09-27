"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Document } from "@/app/components/shared/types";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
    findLibraryDocumentDuplicates,
    findProjectDocumentDuplicates,
    getDocument,
    type LibraryKind,
} from "@/app/lib/mikeApi";
import {
    describeUploadDuplicate,
    findUploadDuplicates,
    type UploadDuplicate,
} from "./uploadDuplicates";

/** Duplicate lines listed in the dialog before "and N more". */
const LINES_SHOWN = 6;

type Choice = "skip" | "all" | "cancel";

export type UploadDuplicateDecision<E> = {
    /** What to upload: everything, or everything that is not a duplicate. */
    upload: E[];
    /**
     * Existing documents to use instead of the skipped files (only with
     * `reuse`): the caller selects or attaches them as if just uploaded.
     */
    reuse: Document[];
};

type DialogState = {
    lines: string[];
    total: number;
    allDuplicates: boolean;
    reuse: boolean;
};

/**
 * The exact-duplicate check for upload entry points outside the document
 * table (chat input and drop, "Add documents", new tabular review, new
 * project). It hashes the files, asks the project which already exist, and —
 * if any do, or a file is picked twice — asks the user in a dialog.
 *
 * Render `duplicateDialog` once in the component, and await
 * `checkProjectUpload` before uploading:
 *
 *   const decision = await checkProjectUpload(projectId, inputs, { reuse: true });
 *   if (!decision) return;            // the user cancelled
 *   decision.reuse.forEach(select);   // existing documents instead of copies
 *   upload(decision.upload);
 *
 * With `reuse`, the confirm button reads "Use existing": callers that select
 * or attach what they upload get the existing document instead of a second
 * copy. Without it, duplicates are simply skipped. If the check cannot run,
 * everything is uploaded unchanged, so the check never blocks an upload.
 */
export function useUploadDuplicateCheck(): {
    checkProjectUpload: <E extends { file: File }>(
        projectId: string,
        entries: E[],
        options?: { reuse?: boolean },
    ) => Promise<UploadDuplicateDecision<E> | null>;
    /**
     * The user's library of this kind: for standalone uploads (chat without
     * a project, "Add documents" outside a project), which become library
     * files.
     */
    checkLibraryUpload: <E extends { file: File }>(
        kind: LibraryKind,
        entries: E[],
        options?: { reuse?: boolean },
    ) => Promise<UploadDuplicateDecision<E> | null>;
    /**
     * Only the selection itself: the same file picked twice. For places
     * without a project yet (creating one), so nothing is sent anywhere.
     */
    checkSelection: <E extends { file: File }>(
        entries: E[],
    ) => Promise<UploadDuplicateDecision<E> | null>;
    duplicateDialog: ReactNode;
} {
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const resolverRef = useRef<((choice: Choice) => void) | null>(null);

    // An unmounted component must not leave its caller waiting forever.
    useEffect(
        () => () => {
            resolverRef.current?.("cancel");
            resolverRef.current = null;
        },
        [],
    );

    const finish = useCallback((choice: Choice) => {
        const resolve = resolverRef.current;
        resolverRef.current = null;
        setDialog(null);
        resolve?.(choice);
    }, []);

    const check = useCallback(
        async <E extends { file: File }>(
            entries: E[],
            find: Parameters<typeof findUploadDuplicates<E>>[1],
            options: { reuse?: boolean } = {},
        ): Promise<UploadDuplicateDecision<E> | null> => {
            const unchanged = { upload: entries, reuse: [] };
            const duplicates = await findUploadDuplicates(entries, find);
            if (!duplicates || duplicates.length === 0) return unchanged;

            const reuse = options.reuse ?? false;
            resolverRef.current?.("cancel");
            const choice = await new Promise<Choice>((resolve) => {
                resolverRef.current = resolve;
                setDialog({
                    lines: duplicates.map(describeUploadDuplicate),
                    total: duplicates.length,
                    allDuplicates: duplicates.length === entries.length,
                    reuse,
                });
            });
            if (choice === "cancel") return null;
            if (choice === "all") return unchanged;

            // With reuse, a duplicate is only skipped once its existing
            // document is in hand: if that cannot be loaded (deleted in the
            // meantime, a failed request), the file is uploaded after all
            // rather than neither uploaded nor attached.
            const loaded = reuse ? await existingDocuments(duplicates) : new Map();
            const skipped = new Set(
                duplicates
                    .filter(
                        (duplicate) =>
                            !reuse ||
                            duplicate.kind === "selection" ||
                            loaded.has(duplicate.matches[0].id),
                    )
                    .map((duplicate) => duplicate.entry),
            );
            return {
                upload: entries.filter((entry) => !skipped.has(entry)),
                reuse: [...loaded.values()],
            };
        },
        [],
    );

    const checkProjectUpload = useCallback(
        <E extends { file: File }>(
            projectId: string,
            entries: E[],
            options: { reuse?: boolean } = {},
        ) =>
            check(
                entries,
                (hashes) => findProjectDocumentDuplicates(projectId, hashes),
                options,
            ),
        [check],
    );

    const checkLibraryUpload = useCallback(
        <E extends { file: File }>(
            kind: LibraryKind,
            entries: E[],
            options: { reuse?: boolean } = {},
        ) =>
            check(
                entries,
                (hashes) => findLibraryDocumentDuplicates(kind, hashes),
                options,
            ),
        [check],
    );

    const checkSelection = useCallback(
        <E extends { file: File }>(entries: E[]) =>
            check(entries, async () => ({})),
        [check],
    );

    const duplicateDialog = (
        <ConfirmPopup
            open={!!dialog}
            title={
                dialog?.total === 1
                    ? "This file is already here"
                    : `${dialog?.total ?? 0} files are already here`
            }
            message={
                dialog ? (
                    <div className="space-y-2">
                        <p>
                            These files have exactly the same content as
                            existing documents or other files in this upload.
                            {dialog.reuse &&
                                " “Use existing” uses the documents already there instead of uploading copies."}
                        </p>
                        <ul className="list-disc space-y-0.5 pl-4 break-words">
                            {dialog.lines.slice(0, LINES_SHOWN).map((line, index) => (
                                <li key={index}>{line}</li>
                            ))}
                        </ul>
                        {dialog.total > LINES_SHOWN && (
                            <p>and {dialog.total - LINES_SHOWN} more</p>
                        )}
                    </div>
                ) : undefined
            }
            confirmLabel={
                dialog?.reuse
                    ? "Use existing"
                    : dialog?.allDuplicates
                      ? "Don't upload"
                      : "Skip duplicates"
            }
            secondaryLabel="Upload anyway"
            onSecondary={() => finish("all")}
            cancelLabel="Cancel"
            onCancel={() => finish("cancel")}
            onConfirm={() => finish("skip")}
        />
    );

    return { checkProjectUpload, checkLibraryUpload, checkSelection, duplicateDialog };
}

/**
 * The existing documents behind "already here" duplicates, by id, loaded so
 * the caller can select them. Documents that cannot be loaded are missing
 * from the map; the caller uploads their files instead.
 */
async function existingDocuments<E extends { file: File }>(
    duplicates: UploadDuplicate<E>[],
): Promise<Map<string, Document>> {
    const ids = [
        ...new Set(
            duplicates.flatMap((duplicate) =>
                duplicate.kind === "existing" ? [duplicate.matches[0].id] : [],
            ),
        ),
    ];
    const loaded = await Promise.allSettled(ids.map((id) => getDocument(id)));
    const byId = new Map<string, Document>();
    loaded.forEach((result, index) => {
        if (result.status === "fulfilled") byId.set(ids[index], result.value);
    });
    return byId;
}
