import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { GlassIconButtonUI } from "@mike/glass-icon-button-ui";
import { VisualViewUI } from "@mike/visual-view-ui";
import { VisualExportMenuUI } from "@mike/visual-export-menu-ui";
import { STALE_SOURCE_NOTICE, type VisualCite } from "@mike/visual-bridge";
import { getVisualSnapshot, type VisualSnapshot } from "../../api/client";
import { useVisualDocument } from "../../hooks/useVisualDocument";
import { insertVisualIntoDocument } from "../../lib/insertVisual";
import { notifyError, notifyInfo, notifySuccess } from "../../lib/notify";
import type { WordVisualRef } from "../../lib/visuals";

// Older Office webviews have no srcdoc, and a visual must never load from a
// URL the pane's origin would vouch for.
const SRCDOC_SUPPORTED =
  typeof document !== "undefined" &&
  "srcdoc" in document.createElement("iframe");

interface VisualSheetProps {
  visual: WordVisualRef;
  onClose: () => void;
  /** Scrolls Word to a cited passage of the open document and selects it. */
  onLocateCitation: (text: string) => void;
}

function citeSource(
  cite: VisualCite,
  sources: VisualSnapshot["sources"] | undefined,
): string {
  const filename = sources?.find(
    (source) => source.document_id === cite.cite,
  )?.filename;
  const from = filename ? `From ${filename}` : "From another document in Mike";
  return cite.page ? `${from}, page ${cite.page}.` : `${from}.`;
}

export function VisualSheet({
  visual,
  onClose,
  onLocateCitation,
}: VisualSheetProps): React.ReactElement {
  const { html, loading, error, retry } = useVisualDocument(
    visual.documentId,
    visual.versionId,
  );
  // Fetched afresh each time the sheet opens: a source can go stale while
  // the cached HTML stays good.
  const [snapshot, setSnapshot] = useState<VisualSnapshot | null>(null);
  const [inserting, setInserting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    getVisualSnapshot(visual.documentId, visual.versionId).then(
      (loaded) => {
        if (!cancelled) setSnapshot(loaded);
      },
      () => {
        // The notice and source names are a courtesy; the page's own stamp
        // still says what it was prepared from.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [visual.documentId, visual.versionId]);

  useEffect(() => {
    const opener = document.activeElement;
    rootRef.current?.querySelector("button")?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const handleCite = useCallback(
    (cite: VisualCite) => {
      if (cite.cite === "active") {
        if (cite.quote) onLocateCitation(cite.quote);
        return;
      }
      notifyInfo(citeSource(cite, snapshot?.sources));
    },
    [onLocateCitation, snapshot],
  );

  const handleInsert = useCallback(async (): Promise<void> => {
    setInserting(true);
    try {
      await insertVisualIntoDocument(visual);
      notifySuccess("Inserted into the document.");
    } catch (insertError) {
      notifyError(insertError, {
        action: "insert the visual",
        page: "Assistant",
        onRetry: handleInsert,
      });
    } finally {
      setInserting(false);
    }
  }, [visual]);

  const stale = snapshot?.sources.some((source) => source.stale) ?? false;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={visual.title}
      data-testid="visual-sheet"
      className="liquid-glass-float absolute inset-0 z-30 flex flex-col pt-14"
    >
      <div className="flex items-start gap-2 px-3 pb-2">
        <GlassIconButtonUI aria-label="Back to chat" onClick={onClose}>
          <ChevronLeft aria-hidden="true" className="h-3.5 w-3.5" />
        </GlassIconButtonUI>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="font-serif text-base font-medium leading-6 text-gray-900 [overflow-wrap:anywhere]">
            {visual.title}
          </h2>
          {typeof visual.versionNumber === "number" && (
            <p className="text-xs text-gray-500">V{visual.versionNumber}</p>
          )}
          {stale && (
            <p className="text-xs text-amber-700">{STALE_SOURCE_NOTICE}</p>
          )}
        </div>
        <VisualExportMenuUI
          onInsert={() => void handleInsert()}
          busyItem={inserting ? "insert" : null}
        />
      </div>
      {/* The composer stays over the sheet, so the frame ends above it. */}
      <div className="flex min-h-0 flex-1 flex-col pb-[var(--composer-h)]">
        {SRCDOC_SUPPORTED ? (
          <VisualViewUI
            html={html ?? ""}
            title={visual.title}
            theme="light"
            loading={loading}
            error={error}
            onRetry={retry}
            onCite={handleCite}
          />
        ) : (
          <p className="px-6 py-4 font-serif text-sm text-gray-500">
            This visual needs a newer version of Word.
          </p>
        )}
      </div>
    </div>
  );
}
