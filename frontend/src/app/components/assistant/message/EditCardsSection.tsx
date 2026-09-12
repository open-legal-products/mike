import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { EditCardsSectionUI } from "@/shared/ui/EditCardsSectionUI";
import { GLASS_CARD_SURFACE_CLASS } from "@/app/components/ui/glass-card";
import { PillButton } from "@/app/components/ui/pill-button";
import { resolveDocumentEdit } from "@/app/lib/mikeApi";
import type { EditAnnotation } from "../../shared/types";
import { applyOptimisticResolution } from "../EditCard";

/**
 * Card rendered above the per-edit EditCards when a message produced
 * multiple tracked-change proposals. Lets the user resolve every pending
 * edit in one click by firing the per-edit accept/reject endpoint for each
 * pending annotation and forwarding each response to `onResolved` so the
 * parent can bump the viewer version, persist override URLs, etc.
 *
 * This intentionally doesn't apply the optimistic DOM mutation that
 * EditCard does — bulk operations touch many edits at once and the real
 * re-render from the latest version will reconcile within a second or so.
 */
function BulkEditActions({
    pending,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: {
    pending: {
        annotation: EditAnnotation;
        filename: string;
    }[];
    onViewClick?: (ann: EditAnnotation, filename: string) => void;
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
    onError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
}) {
    const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
    const [progress, setProgress] = useState<{
        done: number;
        total: number;
    } | null>(null);
    const t = useTranslations("assistant.cartoesEdicao");
    const tShared = useTranslations("shared.trackedChanges");

    if (pending.length === 0) return null;

    const handleAll = async (verb: "accept" | "reject") => {
        if (busy) return;
        setBusy(verb);
        setProgress({ done: 0, total: pending.length });
        try {
            // Sequential so the per-document version counter advances in a
            // predictable order and the viewer doesn't race between bumps.
            let done = 0;
            for (const { annotation } of pending) {
                onResolveStart?.({
                    editId: annotation.edit_id,
                    documentId: annotation.document_id,
                    verb,
                });
                // Optimistically mutate the DOM so the viewer reflects the
                // resolution immediately. Revert if the backend call fails.
                let revert: (() => void) | null = null;
                try {
                    revert = applyOptimisticResolution(annotation, verb);
                } catch (e) {
                    console.error(
                        "[BulkEditActions] optimistic update threw",
                        e,
                    );
                }
                try {
                    const data = await resolveDocumentEdit(
                        annotation.document_id,
                        annotation.edit_id,
                        verb,
                    );
                    const nextStatus =
                        data.status ??
                        (verb === "accept" ? "accepted" : "rejected");
                    onResolved?.({
                        editId: annotation.edit_id,
                        documentId: annotation.document_id,
                        status: nextStatus,
                        versionId: data.version_id,
                        downloadUrl: data.download_url,
                    });
                } catch (e) {
                    console.error("[BulkEditActions] resolve failed", e);
                    try {
                        revert?.();
                    } catch (revertErr) {
                        console.error(
                            "[BulkEditActions] revert threw",
                            revertErr,
                        );
                    }
                    onError?.({
                        editId: annotation.edit_id,
                        documentId: annotation.document_id,
                        versionId: annotation.version_id ?? null,
                        message:
                            verb === "accept"
                                ? t("erroAceitarTudo")
                                : t("erroRejeitarTudo"),
                    });
                }
                done++;
                setProgress({ done, total: pending.length });
            }
        } finally {
            setBusy(null);
            setProgress(null);
        }
    };

    // Optional: show a tiny "View first" action so bulk doesn't lose the
    // in-viewer scroll-to behaviour entirely.
    const first = pending[0];

    return (
        <div className="flex w-full items-center gap-2">
            <PillButton
                tone="blue"
                size="sm"
                onClick={() => handleAll("accept")}
                disabled={!!busy}
                loading={busy === "accept"}
            >
                {busy === "accept" ? t("aceitandoTudo") : tShared("aceitarTudo")}
            </PillButton>
            <PillButton
                tone="white"
                size="sm"
                onClick={() => handleAll("reject")}
                disabled={!!busy}
                loading={busy === "reject"}
            >
                {busy === "reject"
                    ? t("rejeitandoTudo")
                    : tShared("rejeitarTudo")}
            </PillButton>
            {progress && (
                <span className="text-xs font-sans text-gray-500">
                    {progress.done}/{progress.total}
                </span>
            )}
            {onViewClick && first && (
                <PillButton
                    tone="black"
                    size="sm"
                    onClick={() =>
                        onViewClick(first.annotation, first.filename)
                    }
                    disabled={!!busy}
                    className="ml-auto"
                >
                    {tShared("ver")}
                </PillButton>
            )}
        </div>
    );
}

/**
 * Wraps the bulk accept/reject card and the per-edit EditCards in a single
 * minimisable container. The bulk actions and summary stay visible in the
 * header; the individual cards collapse via the chevron toggle.
 */
export function EditCardsSection({
    pending,
    filenameByDocId,
    cards,
    resolvedCount,
    onViewClick,
    onResolveStart,
    onResolved,
    onError,
}: {
    pending: {
        annotation: EditAnnotation;
        filename: string;
    }[];
    filenameByDocId: Map<string, string>;
    cards: ReactNode[];
    resolvedCount: number;
    onViewClick?: (ann: EditAnnotation, filename: string) => void;
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
    onError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
}) {
    const tShared = useTranslations("shared.trackedChanges");
    if (cards.length === 0) return null;

    const docCount = filenameByDocId.size;
    const summary =
        pending.length > 0
            ? docCount > 1
                ? tShared("alteracoesEmDocumentos", {
                      n: pending.length,
                      d: docCount,
                  })
                : pending.length === 1
                  ? tShared("alteracaoRastreada", { n: pending.length })
                  : tShared("alteracoesRastreadas", { n: pending.length })
            : docCount > 1
              ? tShared("alteracoesResolvidasEmDocumentos", {
                    n: resolvedCount,
                    d: docCount,
                })
              : resolvedCount === 1
                ? tShared("alteracaoResolvida", { n: resolvedCount })
                : tShared("alteracoesResolvidas", { n: resolvedCount });

    return (
        <EditCardsSectionUI
            summary={summary}
            className={`${GLASS_CARD_SURFACE_CLASS} overflow-hidden`}
            actions={
                pending.length > 0 ? (
                    <BulkEditActions
                        pending={pending}
                        onViewClick={onViewClick}
                        onResolveStart={onResolveStart}
                        onResolved={onResolved}
                        onError={onError}
                    />
                ) : undefined
            }
        >
            {cards}
        </EditCardsSectionUI>
    );
}
