"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Plus } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { SearchBar } from "@/app/components/ui/search-bar";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Document } from "@/app/components/shared/types";
import {
  addPresetTemplate,
  PRESET_TEMPLATES,
  presetTemplateUrl,
  type PresetTemplate,
} from "./presetTemplates";

const PUBLISHERS = ["All", "General Legal", "Common Paper", "Bonterms"];
const LINK_CLASS =
  "inline-flex max-w-full items-center gap-1.5 rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]";

export function PresetTemplatesModal({
  open,
  onClose,
  folderId,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  folderId: string | null;
  onImported: (document: Document) => void;
}) {
  const [search, setSearch] = useState("");
  const [publisher, setPublisher] = useState("All");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const uploadRef = useRef<AbortController | null>(null);
  useEffect(() => () => uploadRef.current?.abort(), []);

  const query = search.trim().toLowerCase();
  const presets = PRESET_TEMPLATES.filter(
    (preset) =>
      (publisher === "All" || preset.publisher === publisher) &&
      `${preset.title} ${preset.group} ${preset.publisher} ${preset.format}`
        .toLowerCase()
        .includes(query),
  );

  async function handleAdd(preset: PresetTemplate) {
    if (uploadRef.current || added.has(preset.id)) return;
    const controller = new AbortController();
    uploadRef.current = controller;
    setPendingId(preset.id);
    setError(null);
    setStatus(`Adding ${preset.title}…`);
    try {
      const document = await addPresetTemplate(
        preset,
        folderId,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setAdded((current) => new Set(current).add(preset.id));
      setStatus(`Added ${preset.title} to templates.`);
      onImported(document);
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus("");
      setError(
        userFacingApiError(
          error,
          "Could not add this preset. Please try again.",
        ),
      );
    } finally {
      uploadRef.current = null;
      setPendingId(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      breadcrumbs={["Templates", "Browse presets"]}
      size="xl"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 pb-4">
        <p className="text-sm text-muted-foreground">
          Add a personal copy to{" "}
          {folderId ? "this Templates folder" : "Library → Templates"}, or
          download the original.
        </p>
        <SearchBar
          value={search}
          onValueChange={setSearch}
          label="Search presets"
          placeholder="Search agreements, publishers, or packages…"
        />
        <div className="flex flex-wrap gap-2" aria-label="Filter by publisher">
          {PUBLISHERS.map((name) => (
            <TabPillButtonUI
              key={name}
              active={publisher === name}
              onClick={() => setPublisher(name)}
            >
              {name}
            </TabPillButtonUI>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {presets.length} files · Original publisher notices apply. Bonterms
          licenses vary by document.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <p
          role="status"
          className="text-xs text-muted-foreground [overflow-wrap:anywhere]"
        >
          {status}
        </p>
        <ul
          className="min-h-0 flex-1 space-y-2 overflow-y-auto"
          aria-label="Preset templates"
        >
          {presets.map((preset) => (
            <li key={preset.id} className="rounded-xl bg-app-surface p-3">
              <h3 className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                {preset.title}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {preset.group || preset.publisher} ·{" "}
                {preset.format.toUpperCase()}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                {preset.sourceUrl && (
                  <a
                    className={LINK_CLASS}
                    href={preset.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {preset.publisher}
                  </a>
                )}
                {preset.licenseUrl && (
                  <a
                    className={LINK_CLASS}
                    href={preset.licenseUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {preset.license}
                  </a>
                )}
                <a
                  className={LINK_CLASS}
                  href={presetTemplateUrl(preset)}
                  download={preset.filename}
                >
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  Download
                </a>
                {preset.format !== "md" ? (
                  <PillButtonUI
                    tone="white"
                    size="sm"
                    disabled={pendingId !== null || added.has(preset.id)}
                    onClick={() => void handleAdd(preset)}
                  >
                    {pendingId === preset.id ? (
                      <Loader2
                        aria-hidden="true"
                        className="h-3.5 w-3.5 animate-spin"
                      />
                    ) : (
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {added.has(preset.id)
                      ? "Added"
                      : pendingId === preset.id
                        ? "Adding…"
                        : "Add to templates"}
                  </PillButtonUI>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Reference · Download only
                  </span>
                )}
              </div>
            </li>
          ))}
          {presets.length === 0 && (
            <li className="py-8 text-center text-sm text-muted-foreground">
              No presets match your search.
            </li>
          )}
        </ul>
      </div>
    </Modal>
  );
}
