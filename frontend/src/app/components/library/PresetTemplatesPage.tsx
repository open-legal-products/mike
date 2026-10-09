"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { DocTable } from "@/app/components/documents/DocTable";
import type {
  DocTableCatalog,
  DocTableFolderBreadcrumb,
  DocTableSelectionActions,
} from "@/app/components/documents/DocTable";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { SelectionActionsMenu } from "@/app/components/shared/SelectionActionsMenu";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import type { Document } from "@/app/components/shared/types";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { useLibraryWorkspace } from "./LibraryWorkspace";
import {
  addPresetTemplate,
  isPresetDocument,
  PRESET_TEMPLATES,
  presetDirectory,
  presetTemplateUrl,
} from "./presetTemplates";

const PRESETS_BY_ID = new Map(
  PRESET_TEMPLATES.map((preset) => [preset.id, preset]),
);
const PRESET_DIRECTORY = presetDirectory();
// The catalog is bundled with the app and cannot be changed from the table.
async function refuseCatalogChange(): Promise<never> {
  throw new Error("The preset catalog is read-only");
}
const CATALOG_OPERATIONS = {
  uploadDocument: refuseCatalogChange,
  refreshCollection: async () => {},
  createFolder: refuseCatalogChange,
  resolveFolderPath: refuseCatalogChange,
  renameFolder: refuseCatalogChange,
  deleteFolder: refuseCatalogChange,
  moveFolder: refuseCatalogChange,
  moveDocument: refuseCatalogChange,
  renameDocument: refuseCatalogChange,
};
const ignoreCatalogUpdate = () => {};
const refuseCapability = () => false;

function canUsePreset(doc: Document) {
  const preset = PRESETS_BY_ID.get(doc.id);
  return !!preset && isPresetDocument(preset);
}

export function PresetTemplatesPage({
  folderId = null,
}: {
  /** The Templates folder the presets were opened from; copies land there. */
  folderId?: string | null;
}) {
  const router = useRouter();
  const { collections, setDocumentsForKind } = useLibraryWorkspace();
  const templatesLoaded = collections.templates !== null;
  const [search, setSearch] = useState("");
  const [selectionActions, setSelectionActions] =
    useState<DocTableSelectionActions | null>(null);
  const [folderBackAction, setFolderBackAction] = useState<(() => void) | null>(
    null,
  );
  const [folderBreadcrumbs, setFolderBreadcrumbs] = useState<
    Array<{ label: string; onClick: () => void }>
  >([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
  useEffect(() => () => uploadRef.current?.abort(), []);

  const templatesPath = folderId
    ? `/library/templates/folders/${encodeURIComponent(folderId)}`
    : "/library/templates";

  const handleAdd = useCallback(
    async (documents: Document[]) => {
      if (uploadRef.current) return;
      const presets = documents
        .map((document) => PRESETS_BY_ID.get(document.id))
        .filter((preset) => !!preset && isPresetDocument(preset));
      if (presets.length === 0) return;
      const controller = new AbortController();
      uploadRef.current = controller;
      setError(null);
      let added = 0;
      try {
        for (const preset of presets) {
          setStatus(
            presets.length === 1
              ? `Adding ${preset!.filename}…`
              : `Adding ${added + 1} of ${presets.length}…`,
          );
          const document = await addPresetTemplate(
            preset!,
            folderId,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          added += 1;
          // Only a collection that is already loaded is patched; an unloaded
          // one fetches the new copy with everything else when it opens.
          if (templatesLoaded) {
            setDocumentsForKind("templates", (current) => [
              document,
              ...current.filter((item) => item.id !== document.id),
            ]);
          }
        }
        setStatus(
          presets.length === 1
            ? `Added ${presets[0]!.filename} to templates.`
            : `Added ${added} files to templates.`,
        );
      } catch (caught) {
        if (controller.signal.aborted) return;
        setStatus(added > 0 ? `Added ${added} of ${presets.length} files.` : "");
        setError(
          userFacingApiError(
            caught,
            "Could not add this preset. Please try again.",
          ),
        );
      } finally {
        uploadRef.current = null;
      }
    },
    [folderId, setDocumentsForKind, templatesLoaded],
  );

  const catalog = useMemo<DocTableCatalog>(
    () => ({
      resolveDocumentUrl: (documentId) => {
        const preset = PRESETS_BY_ID.get(documentId)!;
        return { url: presetTemplateUrl(preset), filename: preset.filename };
      },
      canPreview: canUsePreset,
      canAdd: canUsePreset,
      addLabel: (count) =>
        count > 1 ? `Add ${count} to templates` : "Add to templates",
      onAdd: (documents) => void handleAdd(documents),
    }),
    [handleAdd],
  );

  const handleFolderBackActionChange = useCallback(
    (action: (() => void) | null) => setFolderBackAction(() => action),
    [],
  );
  const handleFolderViewChange = useCallback(
    (path: DocTableFolderBreadcrumb[]) =>
      setFolderBreadcrumbs(
        path.map((folder) => ({ label: folder.name, onClick: folder.onClick })),
      ),
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        breadcrumbs={[
          { label: "Library", onClick: () => router.push("/library") },
          {
            label: "Templates",
            onClick: () => router.push("/library/templates"),
          },
          { label: "Presets" },
          ...folderBreadcrumbs,
        ]}
        actions={[
          {
            type: "search",
            value: search,
            onChange: setSearch,
            placeholder: "Search presets...",
          },
        ]}
      />

      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <TableToolbar
          leading={
            <TabPillButtonUI
              onClick={folderBackAction ?? (() => router.push(templatesPath))}
              className="pl-2"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Back
            </TabPillButtonUI>
          }
          actions={
            selectionActions ? (
              <SelectionActionsMenu
                renderItems={selectionActions.renderMenuItems}
              />
            ) : undefined
          }
        />
        <div className="mx-4 text-xs text-muted-foreground md:mx-8">
          {error && (
            <p role="alert" className="mb-2 text-destructive">
              {error}
            </p>
          )}
          <p role="status" className="mb-2 empty:hidden [overflow-wrap:anywhere]">
            {status}
          </p>
        </div>
        <DocTable
          scopeKey="preset-templates"
          catalog={catalog}
          documents={PRESET_DIRECTORY.documents}
          setDocuments={ignoreCatalogUpdate}
          folders={PRESET_DIRECTORY.folders}
          setFolders={ignoreCatalogUpdate}
          loading={false}
          search={search}
          operations={CATALOG_OPERATIONS}
          emptyStateTitle="Presets"
          onSelectionActionsChange={setSelectionActions}
          onFolderViewBackActionChange={handleFolderBackActionChange}
          onFolderViewChange={handleFolderViewChange}
          enableHeaderFilters
          // Nothing here is the caller's to edit; adding a copy goes through
          // the catalog, not through a role.
          canDo={refuseCapability}
        />
      </div>
    </div>
  );
}
