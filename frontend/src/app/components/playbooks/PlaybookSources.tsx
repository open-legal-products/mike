"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { Cloud, Loader2, Plus, Upload } from "lucide-react";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { SkeletonLine } from "@/app/components/shared/TablePrimitive";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { PdfView } from "@/app/components/shared/views/PdfView";
import { EmptyState } from "@/app/components/ui/empty-state";
import { EDITOR_SURFACE_CLASS } from "@/app/components/ui/liquid-surface";
import { showToast } from "@/app/components/ui/toast";
import {
  addPlaybookSourceFromDocument,
  deletePlaybookSource,
  getPlaybookSourceUrl,
  getPlaybookSupplementaryFileUrl,
  listPlaybookSources,
  uploadPlaybookSource,
  type PlaybookSupplementarySource,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { PlaybookPanels } from "./PlaybookPanels";
import {
  PLAYBOOK_PANE_EMPTY_CLASS,
  PLAYBOOK_PANE_HEADER_CLASS,
  PLAYBOOK_PANE_LIST_CLASS,
} from "./playbookPaneStyles";

const IMPORTED_ID = "imported";
const ACCEPT =
  ".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SOURCE_FILE = /\.(docx|pdf)$/i;

type ViewedSource = {
  id: string;
  filename: string;
  fileType: "docx" | "pdf";
  url: string;
};

/**
 * The documents behind a playbook: the Word file it was imported from, and
 * supplementary documents its rules can refer to. Reviews see a list of the
 * supplementary ones and read a document only when they need it.
 */
export type PlaybookSourcesHandle = {
  /** Opens the file dialog; call it from a click so the browser allows it. */
  upload: () => void;
};

export function PlaybookSources({
  playbookId,
  sourceFilename,
  revision,
  canEdit = false,
  ref,
}: {
  playbookId: string;
  sourceFilename: string | null;
  /** Changes when the imported file may have been replaced. */
  revision: string;
  canEdit?: boolean;
  /** Lets the page toolbar start an upload. */
  ref?: Ref<PlaybookSourcesHandle>;
}) {
  const [supplementary, setSupplementary] = useState<
    PlaybookSupplementarySource[] | null
  >(null);
  const [pending, setPending] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removing, setRemoving] = useState<PlaybookSupplementarySource | null>(
    null,
  );
  const [removeStatus, setRemoveStatus] = useState<"idle" | "loading">("idle");
  const fileInput = useRef<HTMLInputElement>(null);
  useImperativeHandle(
    ref,
    () => ({
      upload: () => {
        if (canEdit) fileInput.current?.click();
      },
    }),
    [canEdit],
  );

  const load = useCallback(async () => {
    try {
      setSupplementary(await listPlaybookSources(playbookId));
    } catch (error) {
      setSupplementary([]);
      notifyError(error, {
        action: "load the reference documents",
        onRetry: load,
        dedupeKey: `playbook-sources:${playbookId}`,
      });
    }
  }, [playbookId]);

  useEffect(() => {
    void load();
  }, [load]);

  const imported: ViewedSource | null = sourceFilename
    ? {
        id: IMPORTED_ID,
        filename: sourceFilename,
        fileType: "docx",
        url: getPlaybookSourceUrl(playbookId),
      }
    : null;
  const others: ViewedSource[] = (supplementary ?? []).map((source) => ({
    id: source.id,
    filename: source.filename,
    fileType: source.fileType,
    url: getPlaybookSupplementaryFileUrl(playbookId, source.id),
  }));
  const all = imported ? [imported, ...others] : others;
  const selected = all.find((entry) => entry.id === selectedId) ?? all[0];

  async function add(
    names: string[],
    run: (index: number) => Promise<PlaybookSupplementarySource>,
  ) {
    setPending((current) => [...current, ...names]);
    for (const [index, name] of names.entries()) {
      try {
        const added = await run(index);
        setSupplementary((current) => [...(current ?? []), added]);
        setSelectedId(added.id);
      } catch (error) {
        notifyError(error, { action: `add ${name}` });
      } finally {
        setPending((current) => {
          const next = [...current];
          next.splice(next.indexOf(name), 1);
          return next;
        });
      }
    }
  }

  function addFiles(files: File[]) {
    const accepted = files.filter((file) => SOURCE_FILE.test(file.name));
    if (accepted.length < files.length) rejectOtherTypes();
    void add(
      accepted.map((file) => file.name),
      (index) => uploadPlaybookSource(playbookId, accepted[index]),
    );
  }

  async function remove(source: PlaybookSupplementarySource) {
    setRemoveStatus("loading");
    try {
      await deletePlaybookSource(playbookId, source.id);
      setSupplementary((current) =>
        (current ?? []).filter((entry) => entry.id !== source.id),
      );
      setRemoving(null);
    } catch (error) {
      notifyError(error, { action: `remove ${source.filename}` });
    } finally {
      setRemoveStatus("idle");
    }
  }

  function sourceButton(entry: ViewedSource) {
    const active = entry.id === selected?.id;
    const removable = canEdit && entry.id !== IMPORTED_ID;
    const original = supplementary?.find((source) => source.id === entry.id);
    return (
      // One line per document, like the IDE explorer; the full name is in
      // the tooltip and the title row.
      <div
        key={entry.id}
        className={`group flex min-w-0 items-center rounded-lg pr-1 ${active ? "theme-dropdown-selected text-gray-900" : "theme-dropdown-item text-gray-600 hover:text-gray-900"}`}
      >
        <button
          type="button"
          aria-pressed={active}
          title={entry.filename}
          onClick={() => setSelectedId(entry.id)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
          <FileTypeIcon fileType={entry.filename} className="h-3.5 w-3.5" />
          <span className="min-w-0 truncate">{entry.filename}</span>
        </button>
        {removable && original && (
          <HeaderActionsMenu
            title={`Actions for ${entry.filename}`}
            // Hidden until hover only where a pointer can hover; touch keeps it.
            triggerClassName="h-6 w-6 shrink-0 [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
            items={[
              {
                label: "Remove",
                variant: "danger",
                onSelect: () => setRemoving(original),
              },
            ]}
          />
        )}
      </div>
    );
  }

  return (
    <PlaybookPanels
      resizeLabel="Resize references panel"
      sidebar={
        <section
          aria-label="Reference documents"
          className={`flex min-h-0 min-w-0 flex-col ${EDITOR_SURFACE_CLASS}`}
        >
          <div className={`flex items-center justify-between gap-2 ${PLAYBOOK_PANE_HEADER_CLASS}`}>
            <h2 className="text-sm font-medium text-gray-900">References</h2>
            {canEdit && (
              <Dropdown>
                <DropdownTrigger asChild>
                  <TextButtonUI
                    size="icon-xs"
                    className="-my-0.5 h-6"
                    aria-label="Add reference document"
                    title="Add reference document"
                  >
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  </TextButtonUI>
                </DropdownTrigger>
                <DropdownContent align="end" className="w-56">
                  <DropdownItem onSelect={() => fileInput.current?.click()}>
                    <Upload aria-hidden="true" className="h-4 w-4" />
                    Upload a file
                  </DropdownItem>
                  <DropdownItem onSelect={() => setPickerOpen(true)}>
                    <Cloud aria-hidden="true" className="h-4 w-4" />
                    Choose from documents
                  </DropdownItem>
                </DropdownContent>
              </Dropdown>
            )}
          </div>
          {/* One list: the Word file it was imported from, then the rest. */}
          <div className={`max-h-64 min-h-0 overflow-y-auto @[48rem]:max-h-none @[48rem]:flex-1 ${PLAYBOOK_PANE_LIST_CLASS}`}>
            <div className="space-y-1">
              {imported && sourceButton(imported)}
              {supplementary === null ? (
                <div
                  role="status"
                  aria-label="Loading reference documents"
                  className="space-y-1"
                >
                  {["w-3/4", "w-1/2"].map((width) => (
                    <div
                      key={width}
                      aria-hidden="true"
                      className="flex h-7 min-w-0 items-center gap-2 px-2 text-gray-400"
                    >
                      <FileTypeIcon fileType={null} muted />
                      <span className="min-w-0 flex-1">
                        <SkeletonLine className={width} />
                      </span>
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    </div>
                  ))}
                </div>
              ) : (
                others.map(sourceButton)
              )}
              {pending.map((name, index) => (
                <p
                  key={`${name}:${index}`}
                  role="status"
                  title={name}
                  className="flex h-7 min-w-0 items-center gap-2 px-2 text-xs text-gray-500"
                >
                  <FileTypeIcon fileType={name} muted />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="sr-only">Adding </span>
                    {name}
                  </span>
                  <Loader2
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-400"
                  />
                </p>
              ))}
              {!imported &&
                supplementary?.length === 0 &&
                pending.length === 0 && (
                  <p className="px-2 py-1.5 text-xs text-gray-500">
                    None yet.
                  </p>
                )}
            </div>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </section>
      }
    >
      <section
        aria-label="Reference document"
        className={`flex min-h-[24rem] min-w-0 flex-col overflow-hidden @[48rem]:min-h-0 ${EDITOR_SURFACE_CLASS}`}
      >
        {selected && (
          <div className={`flex items-center gap-2 ${PLAYBOOK_PANE_HEADER_CLASS}`}>
            <FileTypeIcon fileType={selected.filename} className="h-4 w-4" />
            <h2
              className="min-w-0 truncate text-sm font-medium text-gray-900"
              title={selected.filename}
            >
              {selected.filename}
            </h2>
          </div>
        )}
        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col pb-4 pt-2 md:pb-5">
            {selected.fileType === "pdf" ? (
              <PdfView
                key={selected.id}
                doc={{ document_id: `playbook-source:${selected.id}` }}
                displayUrl={selected.url}
                rounded={false}
              />
            ) : (
              <DocxView
                key={`${selected.id}:${revision}`}
                documentId={`playbook-source:${playbookId}:${selected.id}`}
                displayUrl={selected.url}
                refetchKey={selected.id === IMPORTED_ID ? revision : undefined}
                filename={selected.filename}
                canEdit={false}
                defaultMode="view"
                // A read-only source: no EigenPal editing toolbar.
                toolbarVisible={false}
                rounded={false}
              />
            )}
          </div>
        ) : (
          <div className={`flex min-h-0 flex-1 items-center justify-center ${PLAYBOOK_PANE_EMPTY_CLASS}`}>
            <EmptyState
              title="No reference documents"
              description={
                canEdit
                  ? "Add documents the rules can refer to, such as policies or templates."
                  : "This playbook has no reference documents."
              }
              action={
                canEdit && (
                  <div className="flex flex-wrap items-center gap-2">
                    <PillButtonUI
                      tone="black"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Upload aria-hidden="true" className="h-3.5 w-3.5" />
                      Upload a file
                    </PillButtonUI>
                    <PillButtonUI tone="white" onClick={() => setPickerOpen(true)}>
                      <Cloud aria-hidden="true" className="h-3.5 w-3.5" />
                      Choose from documents
                    </PillButtonUI>
                  </div>
                )
              }
              className="w-fit max-w-full py-12"
            />
          </div>
        )}
      </section>
      {canEdit && (
        <AddDocumentsModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          breadcrumb={["Playbooks", "References"]}
          uploadStateId={`playbook-sources:${playbookId}`}
          onSelect={(documents) => {
            setPickerOpen(false);
            const accepted = documents.filter((document) =>
              SOURCE_FILE.test(document.filename),
            );
            if (accepted.length < documents.length) rejectOtherTypes();
            void add(
              accepted.map((document) => document.filename),
              (index) =>
                addPlaybookSourceFromDocument(playbookId, accepted[index].id),
            );
          }}
        />
      )}
      <ConfirmPopup
        open={!!removing}
        title={removing ? `Remove ${removing.filename}?` : undefined}
        message="Reviews will no longer be able to read it. The original, if it is in your documents, is not affected."
        confirmLabel="Remove"
        confirmVariant="danger"
        confirmStatus={removeStatus}
        onConfirm={() => removing && void remove(removing)}
        onCancel={() => setRemoving(null)}
      />
    </PlaybookPanels>
  );
}

function rejectOtherTypes() {
  showToast({
    tone: "error",
    title: "Some files were not added",
    message: "References must be .docx or .pdf files.",
  });
}
