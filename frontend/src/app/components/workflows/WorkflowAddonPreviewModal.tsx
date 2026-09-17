"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, Code2, Plus } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type WorkflowAddon } from "../shared/types";
import {
  LIQUID_GLASS_HOVER_CLASS,
  LIQUID_SUBTLE_PANEL_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { Modal } from "../modals/Modal";
import { FileTypeIcon } from "../shared/FileTypeIcon";
import { PdfView } from "../shared/views/PdfView";
import { SpreadsheetView } from "../shared/views/SpreadsheetView";
import { workflowAddonAssetDisplayUrl } from "@/app/lib/mikeApi";
import { resolveDocumentViewType } from "@/app/lib/documentViewType";

type DetailView = "columns" | "skill" | "assets";
type AddonAsset = NonNullable<WorkflowAddon["assets"]>[number];

const DESCRIPTION_PREVIEW_LENGTH = 180;

const markdownComponents: React.ComponentProps<
  typeof ReactMarkdown
>["components"] = {
  h1: ({ children }) => (
    <h3 className="mb-1 mt-4 text-base font-semibold leading-tight text-gray-950 first:mt-0">
      {children}
    </h3>
  ),
  h2: ({ children }) => (
    <h3 className="mb-1 mt-3 text-sm font-semibold leading-tight text-gray-950 first:mt-0">
      {children}
    </h3>
  ),
  h3: ({ children }) => (
    <h3 className="mb-0.5 mt-2 text-xs font-semibold leading-tight text-gray-950 first:mt-0">
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-0.5 pl-4">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-4">{children}</ol>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md border border-gray-300/70 first:mt-0 last:mb-0">
      <table className="min-w-full border-collapse text-left text-xs leading-5">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-r border-gray-300/70 px-3 py-2 font-medium last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-r border-gray-300/70 px-3 py-2 align-top text-gray-700 last:border-r-0">
      {children}
    </td>
  ),
};

function withoutLeadingTitle(markdown: string) {
  return markdown
    .replace(/\r\n/g, "\n")
    .trimStart()
    .replace(/^#{1,3}\s+.+\n?/, "")
    .trimStart();
}

function SkillViewer({ skill }: { skill: string }) {
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const markdown = withoutLeadingTitle(skill);

  async function copy() {
    if (!showRaw && previewRef.current) {
      const html = previewRef.current.innerHTML;
      const text = previewRef.current.innerText;
      try {
        if ("ClipboardItem" in window && navigator.clipboard.write) {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([html], {
                type: "text/html",
              }),
              "text/plain": new Blob([text], {
                type: "text/plain",
              }),
            }),
          ]);
        } else {
          await navigator.clipboard.writeText(text);
        }
      } catch {
        await navigator.clipboard.writeText(text);
      }
    } else {
      await navigator.clipboard.writeText(skill.trim());
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-10 shrink-0 items-center justify-between border-b border-white/60 px-3 py-1.5">
        <span className="text-xs font-medium text-gray-500">SKILL.md</span>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void copy()}
            className="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-gray-700"
          >
            {copied ? <Check className="h-3 w-3" /> : "Copy"}
          </button>
          <button
            type="button"
            aria-label={
              showRaw ? "Show rendered SKILL.md" : "Show raw SKILL.md"
            }
            aria-pressed={showRaw}
            onClick={() => setShowRaw((current) => !current)}
            className={`flex h-7 w-7 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-white/60 hover:text-gray-900 ${
              showRaw ? "bg-white/70 text-gray-950" : ""
            }`}
          >
            <Code2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {showRaw ? (
          <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-gray-700">
            {skill.trim()}
          </pre>
        ) : (
          <div
            ref={previewRef}
            className="space-y-3 font-serif text-sm leading-relaxed text-gray-600"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {markdown || "_No instructions provided._"}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: DetailView; label: string }[];
  active: DetailView;
  onChange: (view: DetailView) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {tabs.map((tab) => (
        <TabPillButtonUI
          key={tab.id}
          active={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </TabPillButtonUI>
      ))}
    </div>
  );
}

function MetadataItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium text-gray-400">{label}</div>
      <div className="mt-0.5 max-w-56 truncate text-xs font-medium text-gray-800">
        {value || "—"}
      </div>
    </div>
  );
}

function formatFileSize(size: number | null) {
  if (size === null) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AddonAssetViewer({
  addonId,
  asset,
}: {
  addonId: string;
  asset: AddonAsset;
}) {
  const displayUrl = workflowAddonAssetDisplayUrl(addonId, asset.id);
  const viewType = resolveDocumentViewType({
    filename: asset.filename,
    fileType: asset.file_type,
    legacyDocViewType: "pdf",
    preferPdfForWord: true,
  });

  if (viewType === "spreadsheet") {
    return (
      <SpreadsheetView documentId={asset.id} displayUrl={displayUrl} rounded />
    );
  }
  return (
    <PdfView doc={{ document_id: asset.id }} displayUrl={displayUrl} rounded />
  );
}

export function WorkflowAddonPreviewModal({
  addon,
  importing,
  onClose,
  onImport,
}: {
  addon: WorkflowAddon | null;
  importing: boolean;
  onClose: () => void;
  onImport: (addon: WorkflowAddon) => Promise<void>;
}) {
  if (!addon) return null;
  return (
    <WorkflowAddonPreviewDialog
      key={addon.id}
      addon={addon}
      importing={importing}
      onClose={onClose}
      onImport={onImport}
    />
  );
}

function WorkflowAddonPreviewDialog({
  addon,
  importing,
  onClose,
  onImport,
}: {
  addon: WorkflowAddon;
  importing: boolean;
  onClose: () => void;
  onImport: (addon: WorkflowAddon) => Promise<void>;
}) {
  const [view, setView] = useState<DetailView>(
    addon.type === "tabular" ? "columns" : "skill",
  );
  const [selectedAsset, setSelectedAsset] = useState<AddonAsset | null>(null);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addon, onClose]);

  const assets = addon.assets ?? [];
  const tabs: { id: DetailView; label: string }[] =
    addon.type === "tabular"
      ? [{ id: "columns", label: "Columns" }]
      : [
          { id: "skill", label: "SKILL.md" },
          ...(assets.length > 0
            ? [{ id: "assets" as const, label: "Assets" }]
            : []),
        ];

  return (
    <Modal
      open
      onClose={onClose}
      breadcrumbs={[
        "Workflows",
        "Add-ons",
        addon.title,
        ...(selectedAsset ? [selectedAsset.filename] : []),
      ]}
      size={selectedAsset ? "xl" : "lg"}
      primaryAction={{
        label: importing ? "Importing…" : "Import",
        icon: <Plus className="h-4 w-4" />,
        disabled: importing,
        onClick: () => void onImport(addon),
      }}
      secondaryAction={
        selectedAsset
          ? {
              label: "Back",
              icon: <ChevronLeft className="h-4 w-4" />,
              onClick: () => setSelectedAsset(null),
            }
          : undefined
      }
      cancelAction={false}
    >
      {selectedAsset ? (
        <div className="mb-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg">
          <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-white/60 py-1.5 text-xs">
            <FileTypeIcon
              fileType={selectedAsset.file_type || selectedAsset.filename}
              className="h-4 w-4"
            />
            <span className="min-w-0 flex-1 truncate font-medium text-gray-800">
              {selectedAsset.filename}
            </span>
            <span className="shrink-0 uppercase text-gray-400">
              {selectedAsset.file_type}
            </span>
            <span className="shrink-0 text-gray-400">
              {formatFileSize(selectedAsset.size_bytes)}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <AddonAssetViewer addonId={addon.id} asset={selectedAsset} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col pb-3">
          <div className="flex shrink-0 items-start justify-between gap-4 pb-5">
            <h2 className="min-w-0 font-serif text-xl font-medium leading-tight tracking-tight text-gray-950">
              {addon.title}
            </h2>
          </div>
          <section className="shrink-0">
            <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
              <MetadataItem
                label="Contributor"
                value={addon.contributors
                  .map((contributor) => contributor.name)
                  .join(", ")}
              />
              <MetadataItem label="Language" value={addon.language || "—"} />
              <MetadataItem label="Version" value={addon.version || "—"} />
              <MetadataItem
                label="Practice"
                value={addon.practice || "General"}
              />
              <MetadataItem
                label="Jurisdiction"
                value={addon.jurisdictions?.join(", ") || "—"}
              />
            </div>
            {addon.description && (
              <div className="mt-3 max-w-4xl text-xs leading-5 text-gray-600">
                <p>
                  {descriptionExpanded ||
                  addon.description.length <= DESCRIPTION_PREVIEW_LENGTH
                    ? addon.description
                    : `${addon.description.slice(0, DESCRIPTION_PREVIEW_LENGTH).trimEnd()}…`}
                  {addon.description.length > DESCRIPTION_PREVIEW_LENGTH && (
                    <button
                      type="button"
                      aria-expanded={descriptionExpanded}
                      onClick={() =>
                        setDescriptionExpanded((expanded) => !expanded)
                      }
                      className="ml-1 inline font-medium text-blue-600 transition-colors hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
                    >
                      {descriptionExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                </p>
              </div>
            )}
          </section>

          <div className="mt-4 mb-2 flex min-h-0 flex-1 flex-col">
            {tabs.length > 1 && (
              <div className="mb-3 flex shrink-0 items-center">
                <DetailTabs tabs={tabs} active={view} onChange={setView} />
              </div>
            )}
            <div
              className={`${LIQUID_SUBTLE_PANEL_SURFACE_CLASS} flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl`}
            >
              {view === "columns" ? (
                <>
                  <div className="grid min-h-10 shrink-0 grid-cols-[52px_0.8fr_1.8fr] items-center border-b border-white/60 text-xs font-medium text-gray-500">
                    <div className="px-3 py-1.5">#</div>
                    <div className="border-l border-white/60 px-3 py-1.5">
                      Column
                    </div>
                    <div className="border-l border-white/60 px-3 py-1.5">
                      Prompt
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {(addon.columns_config ?? []).map((column) => (
                      <div
                        key={`${column.index}-${column.name}`}
                        className="grid grid-cols-[52px_0.8fr_1.8fr] border-b border-white/50 text-xs last:border-b-0"
                      >
                        <div className="px-3 py-3 text-gray-400">
                          {column.index + 1}
                        </div>
                        <div className="border-l border-white/50 px-3 py-3 font-medium text-gray-800">
                          {column.name}
                        </div>
                        <div className="border-l border-white/50 px-3 py-3 text-gray-600">
                          {column.prompt}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : view === "assets" ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex min-h-10 shrink-0 items-center border-b border-white/60 px-3 py-1.5 text-xs font-medium text-gray-500">
                    Assets
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {assets.length === 0 ? (
                      <div className="flex h-full min-h-24 items-center justify-center px-4 text-xs text-gray-400">
                        No assets included.
                      </div>
                    ) : (
                      assets.map((file) => (
                        <button
                          key={file.id}
                          type="button"
                          onClick={() => setSelectedAsset(file)}
                          className={`flex w-full items-center gap-3 border-b border-white/50 px-3 py-3 text-left text-xs transition-colors last:border-b-0 ${LIQUID_GLASS_HOVER_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/60`}
                        >
                          <FileTypeIcon
                            fileType={file.file_type || file.filename}
                            className="h-4 w-4"
                          />
                          <span className="min-w-0 flex-1 truncate font-medium text-gray-800">
                            {file.filename}
                          </span>
                          <span className="shrink-0 text-xs uppercase text-gray-400">
                            {file.file_type}
                          </span>
                          <span className="w-16 shrink-0 text-right text-xs text-gray-400">
                            {formatFileSize(file.size_bytes)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <SkillViewer skill={addon.prompt_md ?? ""} />
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
