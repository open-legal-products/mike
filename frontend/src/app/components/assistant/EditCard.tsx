"use client";

import { useEffect, useState } from "react";
import { EditCardUI } from "@/shared/ui/EditCardUI";
import { resolveDocumentEdit } from "@/app/lib/mikeApi";
import type { EditAnnotation } from "../shared/types";
import { RESPONSE_GLASS_SURFACE } from "./message/messageStyles";
import { docxRevisionElements } from "../shared/views/docxRevisionElements";

/**
 * Ephemeral DOM mutation so the tracked change visually resolves the
 * instant the user clicks Accept/Reject, instead of waiting for the
 * backend round-trip + re-render. The real re-render from the new
 * version supersedes this shortly after.
 */
/**
 * Apply the optimistic DOM mutation for an accept/reject click. Returns
 * a revert function that undoes every style + class the mutation added,
 * so if the backend call later fails we can restore the original look.
 */
export function applyOptimisticResolution(
    annotation: EditAnnotation,
    verb: "accept" | "reject",
): () => void {
    const reverts: (() => void)[] = [];
    if (typeof document === "undefined") return () => {};

    const hide = (el: HTMLElement) => {
        el.classList.add("docx-edit-hidden");
        const prev = el.style.getPropertyValue("display");
        const prevPriority = el.style.getPropertyPriority("display");
        el.style.setProperty("display", "none", "important");
        reverts.push(() => {
            el.classList.remove("docx-edit-hidden");
            if (prev) el.style.setProperty("display", prev, prevPriority);
            else el.style.removeProperty("display");
        });
    };
    const keep = (el: HTMLElement) => {
        el.classList.add("docx-edit-kept");
        const snapshot = {
            color: [
                el.style.getPropertyValue("color"),
                el.style.getPropertyPriority("color"),
            ] as const,
            bg: [
                el.style.getPropertyValue("background-color"),
                el.style.getPropertyPriority("background-color"),
            ] as const,
            td: [
                el.style.getPropertyValue("text-decoration"),
                el.style.getPropertyPriority("text-decoration"),
            ] as const,
        };
        el.style.setProperty("color", "inherit", "important");
        el.style.setProperty("background-color", "transparent", "important");
        el.style.setProperty("text-decoration", "none", "important");
        reverts.push(() => {
            el.classList.remove("docx-edit-kept");
            const restore = (
                prop: "color" | "background-color" | "text-decoration",
                [v, p]: readonly [string, string],
            ) => {
                if (v) el.style.setProperty(prop, v, p);
                else el.style.removeProperty(prop);
            };
            restore("color", snapshot.color);
            restore("background-color", snapshot.bg);
            restore("text-decoration", snapshot.td);
        });
    };

    const scrolls = document.querySelectorAll(
        `[data-document-id="${CSS.escape(annotation.document_id)}"]`,
    );
    scrolls.forEach((scroll) => {
        const container = scroll.querySelector(".docx-view-container");
        if (!container) return;

        const insertions = docxRevisionElements(container, "ins", annotation.ins_w_id, annotation.inserted_text);
        const deletions = docxRevisionElements(container, "del", annotation.del_w_id, annotation.deleted_text);

        if (verb === "accept") {
            insertions.forEach(keep);
            deletions.forEach(hide);
        } else {
            insertions.forEach(hide);
            deletions.forEach(keep);
        }
    });

    return () => reverts.forEach((fn) => fn());
}

interface Props {
    annotation: EditAnnotation;
    changeNumber?: number;
    /**
     * External override for this edit's status. When set, takes
     * precedence over the annotation's DB status and the card's own
     * internal state — used so bulk-resolved edits flip their per-card
     * UI the moment the bulk handler calls onResolved.
     */
    resolvedStatus?: "accepted" | "rejected";
    /**
     * True while an accept/reject request for any edit on this document
     * is in flight (from here, DocPanel, or the bulk bar). When true the
     * Accept/Reject buttons disable so the user can't race resolutions.
     */
    isReloading?: boolean;
    onViewClick?: (ann: EditAnnotation) => void;
    /** Renders the dismiss control. Omit where the card cannot be closed. */
    onClose?: () => void;
    /**
     * Fires immediately when the user clicks Accept or Reject, before the
     * backend round-trip. Parents use this to show an in-progress spinner
     * on download cards / editor panels tied to the same document while
     * the version is being mutated.
     */
    onResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    /**
     * Fires when the backend accept/reject call fails. The optimistic
     * DOM mutation has already been reverted. Parent should surface a
     * warning (e.g. on the DocxView for this document + version) and
     * clear the per-edit in-flight state keyed on `editId`.
     */
    onError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
}

/**
 * Renders a single tracked-change proposal as a card in the assistant
 * message with Accept / Reject / View controls.
 */
export function EditCard({
    annotation,
    changeNumber,
    resolvedStatus,
    isReloading,
    onViewClick,
    onClose,
    onResolveStart,
    onResolved,
    onError,
}: Props) {
    const [busyAction, setBusyAction] = useState<
        "accept" | "reject" | null
    >(null);
    const busy = busyAction !== null;
    const [localStatus, setLocalStatus] = useState<
        "pending" | "accepted" | "rejected"
    >(annotation.status);
    // External override (from a bulk resolve) takes precedence over the
    // card's own click-driven state.
    const status = resolvedStatus ?? localStatus;

    useEffect(() => {
        if (busy) return;
        setLocalStatus(annotation.status);
    }, [annotation.edit_id, annotation.status, busy]);

    const resolved = status !== "pending";

    const handle = async (verb: "accept" | "reject") => {
        if (busy || resolved) return;
        setBusyAction(verb);
        onResolveStart?.({
            editId: annotation.edit_id,
            documentId: annotation.document_id,
            verb,
        });
        let revert: (() => void) | null = null;
        try {
            revert = applyOptimisticResolution(annotation, verb);
        } catch (e) {
            console.error("[EditCard] optimistic update threw", e);
        }
        try {
            const data = await resolveDocumentEdit(
                annotation.document_id,
                annotation.edit_id,
                verb,
            );
            const nextStatus =
                data.status ?? (verb === "accept" ? "accepted" : "rejected");
            setLocalStatus(nextStatus);
            onResolved?.({
                editId: annotation.edit_id,
                documentId: annotation.document_id,
                status: nextStatus,
                versionId: data.version_id,
                downloadUrl: data.download_url,
            });
        } catch (e) {
            console.error("EditCard resolve failed", e);
            try {
                revert?.();
            } catch (revertErr) {
                console.error("[EditCard] revert threw", revertErr);
            }
            onError?.({
                editId: annotation.edit_id,
                documentId: annotation.document_id,
                versionId: annotation.version_id ?? null,
                message:
                    verb === "accept"
                        ? "Couldn't save accept — reverted."
                        : "Couldn't save reject — reverted.",
            });
        } finally {
            setBusyAction(null);
        }
    };

    return (
        <EditCardUI
            originalText={annotation.deleted_text}
            replacementText={annotation.inserted_text}
            reason={annotation.reason}
            changeNumber={changeNumber}
            status={status}
            ariaBusy={!!isReloading}
            className={`${RESPONSE_GLASS_SURFACE} p-2`}
            actionsDisabled={!!isReloading}
            busyAction={busyAction ?? undefined}
            onClose={onClose}
            onAccept={() => handle("accept")}
            onReject={() => handle("reject")}
            onView={
                onViewClick ? () => onViewClick(annotation) : undefined
            }
        />
    );
}
