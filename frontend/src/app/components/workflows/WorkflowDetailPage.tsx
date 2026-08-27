"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Check,
  ChevronDown,
  Download,
  Globe,
  Pencil,
  Play,
  Plus,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import {
  deleteWorkflowShare,
  deleteWorkflow,
  getWorkflow,
  listWorkflowShares,
  lookupUserByEmail,
  shareWorkflow,
  updateWorkflow,
  type ProjectPeople,
} from "@/app/lib/mikeApi";
import { UseWorkflowModal } from "@/app/components/workflows/UseWorkflowModal";
import { WFEditColumnModal } from "@/app/components/workflows/WFEditColumnModal";
import { WFColumnViewModal } from "@/app/components/workflows/WFColumnViewModal";
import { AddColumnModal } from "@/app/components/tabular/AddColumnModal";
import type { ColumnConfig, Workflow } from "@/app/components/shared/types";
import {
  formatIcon,
  formatIconClassName,
  formatLabel,
} from "@/app/components/tabular/columnFormat";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import {
  HeaderActionsMenu,
  type HeaderActionsMenuItem,
} from "@/app/components/shared/HeaderActionsMenu";
import { PeopleModal } from "@/app/components/modals/PeopleModal";
import { OpenSourceWorkflowModal } from "@/app/components/workflows/OpenSourceWorkflowModal";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import {
  LIQUID_GLASS_FLOAT_CLASS,
  LIQUID_TABLE_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import { NewWorkflowModal } from "@/app/components/workflows/NewWorkflowModal";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import {
  TABLE_CHECKBOX_CLASS,
  SkeletonCheckbox,
  SkeletonLine,
  TableBody,
  TableCell,
  TableEmptyState,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  TableStickyCell,
  selectedIdsAfterRangeClick,
  selectedIdsAfterShiftClick,
} from "@/app/components/shared/TablePrimitive";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { RowActions } from "@/app/components/shared/RowActions";
import { TRExpandedCellSurface } from "@/app/components/tabular/TRExpandedCellSurface";
import { UploadOverlay } from "@/app/components/assistant/UploadOverlay";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useQueryParamTab } from "@/app/hooks/useQueryParamTab";
import { downloadWorkflowZip } from "./workflowZipExport";
import {
  WorkflowReferenceFiles,
  type WorkflowReferenceFilesHandle,
} from "./WorkflowReferenceFiles";
// dynamic import keeps Tiptap (browser-only) out of the SSR bundle
const WorkflowPromptEditor = dynamic(
  () =>
    import("@/app/components/workflows/WorkflowPromptEditor").then((m) => ({
      default: m.WorkflowPromptEditor,
    })),
  { ssr: false },
);

interface Props {
  id: string;
  workflowType: Workflow["metadata"]["type"];
}

type SaveStatus = "idle" | "saving" | "saved";
type DeleteStatus = "idle" | "loading" | "complete";
type AssistantTab = "prompt" | "assets";
type WorkflowShare = Awaited<ReturnType<typeof listWorkflowShares>>[number];

const NAME_COL_W = "w-[332px] shrink-0";
const PROMPT_COL_W = "min-w-[240px] max-w-[360px] flex-1";
const PROMPT_HEADER_WITH_ACTIONS_W = "min-w-[272px] max-w-[392px] flex-1 pr-8";
const WORKFLOW_CONTRIBUTIONS_ENABLED =
  process.env.NEXT_PUBLIC_WORKFLOW_CONTRIBUTIONS_ENABLED === "true";
const ASSISTANT_TABS: readonly AssistantTab[] = ["prompt", "assets"];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function WorkflowDetailPage({ id, workflowType }: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const readOnly =
    (workflow?.is_system ?? false) || workflow?.allow_edit === false;
  const canShare = !readOnly && (workflow?.is_owner ?? true);
  const canOpenSource =
    WORKFLOW_CONTRIBUTIONS_ENABLED && canShare && workflow?.is_system !== true;

  // Editor state
  const [promptMd, setPromptMd] = useState("");
  const [columns, setColumns] = useState<ColumnConfig[]>([]);
  const [referenceFilesUploading, setReferenceFilesUploading] = useState(false);
  const [draggingReferenceFiles, setDraggingReferenceFiles] = useState(false);
  const referenceFilesRef = useRef<WorkflowReferenceFilesHandle>(null);
  const pendingReferenceFilesRef = useRef<File[] | null>(null);
  const searchParams = useSearchParams();
  const [assistantTab, setAssistantTab] = useQueryParamTab(
    ASSISTANT_TABS,
    "prompt",
    false,
    workflowType === "assistant",
  );
  const previewEmptyStates = searchParams.get("emptyStates") === "1";
  const visibleColumns = previewEmptyStates ? [] : columns;

  // Save status
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Column selection
  const [selectedColIndices, setSelectedColIndices] = useState<number[]>([]);
  const columnSelectionAnchorRef = useRef<number | null>(null);
  const [expandedPromptIndex, setExpandedPromptIndex] = useState<number | null>(
    null,
  );

  // Column modal
  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [editingColumn, setEditingColumn] = useState<ColumnConfig | null>(null);
  const [viewingColumn, setViewingColumn] = useState<ColumnConfig | null>(null);

  // Share / use / details popovers
  const [shareOpen, setShareOpen] = useState(false);
  const [workflowSharedWith, setWorkflowSharedWith] = useState<string[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [useOpen, setUseOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<DeleteStatus>("idle");
  const [openSourceOpen, setOpenSourceOpen] = useState(false);

  // Column actions dropdown
  const [colActionsOpen, setColActionsOpen] = useState(false);
  const colActionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        colActionsRef.current &&
        !colActionsRef.current.contains(e.target as Node)
      ) {
        setColActionsOpen(false);
      }
    }
    if (colActionsOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [colActionsOpen]);

  useEffect(() => {
    if (assistantTab !== "assets" || !pendingReferenceFilesRef.current) return;
    const pendingFiles = pendingReferenceFilesRef.current;
    pendingReferenceFilesRef.current = null;
    referenceFilesRef.current?.uploadFiles(pendingFiles);
  }, [assistantTab]);

  function hasFilePayload(dataTransfer: DataTransfer) {
    return Array.from(dataTransfer.types).includes("Files");
  }

  function handleReferenceDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    if (
      workflow?.metadata.type !== "assistant" ||
      readOnly ||
      referenceFilesUploading
    ) {
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    setDraggingReferenceFiles(true);
  }

  function handleReferenceDragLeave(event: DragEvent<HTMLDivElement>) {
    if (
      !event.currentTarget.contains(event.relatedTarget as Node | null)
    ) {
      setDraggingReferenceFiles(false);
    }
  }

  function handleReferenceDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDraggingReferenceFiles(false);
    if (workflow?.metadata.type !== "assistant" || readOnly) return;
    // A batch is already uploading: dropping more files now would interleave
    // with it (WorkflowReferenceFiles also rejects and explains). The toolbar
    // button is disabled for the same window.
    if (referenceFilesUploading) return;

    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    if (assistantTab === "assets" && referenceFilesRef.current) {
      referenceFilesRef.current.uploadFiles(files);
      return;
    }
    pendingReferenceFilesRef.current = files;
    setAssistantTab("assets");
  }

  // ---------------------------------------------------------------------------
  // Load workflow
  // ---------------------------------------------------------------------------
  useEffect(() => {
    getWorkflow(id)
      .then((wf) => {
        if (wf.metadata.type !== workflowType) {
          setNotFound(true);
          return;
        }
        setWorkflow(wf);
        setPromptMd(wf.skill_md ?? "");
        setColumns(
          (wf.columns_config ?? []).slice().sort((a, b) => a.index - b.index),
        );
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id, workflowType]);

  const fetchWorkflowShares = useCallback(async () => {
    const shares = await listWorkflowShares(id);
    setWorkflowSharedWith(
      shares.map((share) => share.shared_with_email.trim().toLowerCase()),
    );
    return shares;
  }, [id]);

  const fetchWorkflowPeople = useCallback(async (): Promise<ProjectPeople> => {
    const shares = await fetchWorkflowShares();
    const members = await Promise.all(
      shares.map(async (share) => {
        const email = share.shared_with_email.trim().toLowerCase();
        const userResult = await lookupUserByEmail(email).catch(() => null);
        return {
          email,
          display_name:
            userResult?.exists === true ? userResult.display_name : null,
        };
      }),
    );
    return {
      owner: {
        user_id: user?.id ?? workflow?.user_id ?? "",
        email: user?.email ?? null,
        display_name: profile?.displayName ?? null,
      },
      members,
    };
  }, [
    fetchWorkflowShares,
    profile?.displayName,
    user?.email,
    user?.id,
    workflow?.user_id,
  ]);

  async function handleWorkflowSharedWithChange(nextSharedWith: string[]) {
    const nextEmails = [
      ...new Set(
        nextSharedWith
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const currentShares = await listWorkflowShares(id);
    const currentByEmail = new Map<string, WorkflowShare>();
    for (const share of currentShares) {
      currentByEmail.set(share.shared_with_email.trim().toLowerCase(), share);
    }

    const added = nextEmails.filter((email) => !currentByEmail.has(email));
    const removed = currentShares.filter(
      (share) =>
        !nextEmails.includes(share.shared_with_email.trim().toLowerCase()),
    );

    await Promise.all([
      ...removed.map((share) => deleteWorkflowShare(id, share.id)),
      ...(added.length > 0
        ? [shareWorkflow(id, { emails: added, allow_edit: false })]
        : []),
    ]);

    await fetchWorkflowShares();
  }

  // ---------------------------------------------------------------------------
  // Debounced auto-save for prompt
  // ---------------------------------------------------------------------------
  const save = useCallback(
    (newPromptMd: string) => {
      if (readOnly) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSaveStatus("saving");
      debounceRef.current = setTimeout(async () => {
        try {
          await updateWorkflow(id, { skill_md: newPromptMd });
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus("idle"), 2000);
        } catch {
          setSaveStatus("idle");
        }
      }, 800);
    },
    [id, readOnly],
  );

  async function handleDeleteWorkflow() {
    if (!workflow || readOnly || workflow.is_owner === false) return;
    setDeleteStatus("loading");
    try {
      await deleteWorkflow(id);
      setDeleteStatus("complete");
      setTimeout(() => router.push("/workflows"), 600);
    } catch {
      setDeleteStatus("idle");
    }
  }

  function handlePromptChange(val: string | undefined) {
    const next = val ?? "";
    setPromptMd(next);
    save(next);
  }

  // ---------------------------------------------------------------------------
  // Column save
  // ---------------------------------------------------------------------------
  async function saveColumns(next: ColumnConfig[]) {
    if (readOnly) return;
    setSaveStatus("saving");
    try {
      const updated = await updateWorkflow(id, { columns_config: next });
      setWorkflow((current) => ({
        ...updated,
        open_source_submission:
          updated.open_source_submission ??
          current?.open_source_submission ??
          null,
      }));
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch {
      setSaveStatus("idle");
    }
  }

  function handleColumnsAdded(added: ColumnConfig[]) {
    const next = [
      ...columns,
      ...added.map((c, i) => ({ ...c, index: columns.length + i })),
    ];
    setColumns(next);
    saveColumns(next);
    setAddColumnOpen(false);
  }

  function handleDeleteSelectedColumns() {
    const next = columns
      .filter((column) => !selectedColIndices.includes(column.index))
      .map((column, index) => ({ ...column, index }));
    setColumns(next);
    saveColumns(next);
    setSelectedColIndices([]);
    setColActionsOpen(false);
  }

  function handleColumnSaved(updated: ColumnConfig) {
    const next = columns.map((c) => (c.index === updated.index ? updated : c));
    setColumns(next);
    saveColumns(next);
    setEditingColumn(null);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader
          shrink
          breadcrumbs={[
            {
              label: "Workflows",
              onClick: () => router.push("/workflows"),
              title: "Back to Workflows",
            },
            { loading: true, skeletonClassName: "w-40" },
          ]}
        />
        <div className="flex min-h-0 flex-1 flex-col">
          {workflowType === "tabular" ? (
            <TabularWorkflowEditorSkeleton />
          ) : (
            <AssistantWorkflowEditorSkeleton />
          )}
        </div>
      </div>
    );
  }

  if (notFound || !workflow) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-400 font-serif">Workflow not found.</p>
      </div>
    );
  }

  const defaultContributorName =
    profile?.displayName?.trim() || user?.email || "your account name";
  const openSourcePending =
    workflow.open_source_submission?.status === "pending";
  const workflowActionItems: HeaderActionsMenuItem[] = [
    {
      label: "Download workflow",
      icon: Download,
      onSelect: () => downloadWorkflowZip(workflow, promptMd, columns),
    },
    {
      label: "View and Edit details",
      icon: Pencil,
      onSelect: () => setDetailsOpen(true),
    },
  ];

  if (!readOnly) {
    if (canOpenSource) {
      workflowActionItems.push({
        label: "Open source this",
        icon: Globe,
        onSelect: () => setOpenSourceOpen(true),
      });
    }

    workflowActionItems.push({
      label: "Delete",
      icon: Trash2,
      variant: "danger",
      disabled: workflow.is_owner === false,
      onSelect: () => {
        setDeleteStatus("idle");
        setDeleteOpen(true);
      },
    });
  }

  return (
    <div
      className="flex flex-col h-full"
      onDragOver={handleReferenceDragOver}
      onDragLeave={handleReferenceDragLeave}
      onDrop={handleReferenceDrop}
    >
      <UploadOverlay
        open={draggingReferenceFiles}
        label="Drop files here to add as workflow assets"
      />
      {/* Page header */}
      <PageHeader
        shrink
        breadcrumbs={[
          {
            label: "Workflows",
            onClick: () => router.push("/workflows"),
            title: "Back to Workflows",
          },
          {
            label: (
              <span className="text-gray-900 truncate max-w-xs">
                {workflow.metadata.title}
              </span>
            ),
          },
        ]}
        actionGroups={[
          saveStatus !== "idle"
            ? [
                {
                  type: "custom",
                  render: (
                    <span className="inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-sm text-gray-500">
                      {saveStatus === "saved" ? (
                        <Check className="h-3.5 w-3.5 text-green-600" />
                      ) : null}
                      {saveStatus === "saving" ? "Saving…" : "Saved"}
                    </span>
                  ),
                },
              ]
            : [],
          [
            canShare
              ? {
                  onClick: () => setShareOpen(true),
                  title: "Open workflow people",
                  iconOnly: true,
                  icon: <Users className="h-4 w-4" />,
                }
              : null,
            {
              type: "custom",
              render: (
                <HeaderActionsMenu
                  title="Workflow actions"
                  items={workflowActionItems}
                />
              ),
            },
          ],
          [
            {
              label: "Use",
              icon: <Play className="h-3.5 w-3.5" />,
              onClick: () => setUseOpen(true),
            },
          ],
        ]}
      />
      <UseWorkflowModal
        workflow={useOpen ? workflow : null}
        onClose={() => setUseOpen(false)}
        skipSelect
      />
      <NewWorkflowModal
        open={detailsOpen}
        editWorkflow={workflow}
        readOnly={readOnly}
        onClose={() => setDetailsOpen(false)}
        onCreated={() => undefined}
        onUpdated={(updated) => {
          setWorkflow((current) =>
            current
              ? {
                  ...current,
                  ...updated,
                  shared_by_name:
                    updated.shared_by_name ?? current.shared_by_name ?? null,
                  open_source_submission:
                    updated.open_source_submission ??
                    current.open_source_submission ??
                    null,
                }
              : updated,
          );
          setDetailsOpen(false);
        }}
      />
      {shareOpen && (
        <PeopleModal
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          resource={{ id, shared_with: workflowSharedWith }}
          fetchPeople={fetchWorkflowPeople}
          currentUserEmail={user?.email ?? null}
          breadcrumb={["Workflows", workflow.metadata.title, "People"]}
          onSharedWithChange={handleWorkflowSharedWithChange}
        />
      )}
      <ConfirmPopup
        open={deleteOpen}
        title="Delete workflow?"
        message={
          workflow.is_default
            ? "Deleting this default workflow also permanently deletes its corresponding Quick Action. The default workflow will not be created again automatically."
            : "This workflow will be permanently deleted."
        }
        confirmLabel="Delete"
        confirmStatus={deleteStatus}
        onConfirm={() => void handleDeleteWorkflow()}
        onCancel={() => {
          if (deleteStatus === "loading") return;
          setDeleteOpen(false);
          setDeleteStatus("idle");
        }}
      />
      <OpenSourceWorkflowModal
        open={openSourceOpen}
        onClose={() => setOpenSourceOpen(false)}
        workflowId={id}
        defaultContributorName={defaultContributorName}
        pending={openSourcePending}
        onSubmitted={(submission) =>
          setWorkflow((current) =>
            current
              ? {
                  ...current,
                  open_source_submission: submission,
                }
              : current,
          )
        }
      />

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col">
        {workflow.metadata.type === "assistant" ? (
          /* ── Assistant: WYSIWYG editor ── */
          <>
            <TableToolbar<AssistantTab>
              items={[
                { id: "prompt", label: "Prompt" },
                { id: "assets", label: "Assets" },
              ]}
              active={assistantTab}
              onChange={setAssistantTab}
              actions={
                assistantTab === "assets" && !readOnly ? (
                  <TabPillButton
                    disabled={referenceFilesUploading}
                    onClick={() =>
                      referenceFilesRef.current?.openUploadPicker()
                    }
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {referenceFilesUploading ? "Uploading…" : "Upload files"}
                  </TabPillButton>
                ) : undefined
              }
            />
            {assistantTab === "prompt" ? (
              <div className="mx-4 mb-2 min-h-0 min-w-0 flex-1 md:mx-8 md:mb-3">
                <WorkflowPromptEditor
                  value={promptMd}
                  onChange={readOnly ? undefined : handlePromptChange}
                  readOnly={readOnly}
                />
              </div>
            ) : (
              <WorkflowReferenceFiles
                ref={referenceFilesRef}
                workflowId={id}
                readOnly={readOnly}
                onUploadingChange={setReferenceFilesUploading}
              />
            )}
          </>
        ) : (
          /* ── Tabular: Column table ── */
          <>
            {!readOnly && (
              <TableToolbar
                actions={
                  <div className="flex items-center gap-2">
                    {visibleColumns.length > 0 &&
                      selectedColIndices.length > 0 && (
                        <>
                          <div
                            ref={colActionsRef}
                            className="relative max-md:hidden"
                          >
                            <TabPillButton
                              onClick={() => setColActionsOpen((open) => !open)}
                            >
                              Actions
                              <ChevronDown className="h-3.5 w-3.5" />
                            </TabPillButton>
                            {colActionsOpen && (
                              <div className={`absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-lg ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`}>
                                <button
                                  onClick={handleDeleteSelectedColumns}
                                  className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                                >
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                          <TabPillButton
                            onClick={handleDeleteSelectedColumns}
                            className="text-red-600 md:hidden"
                          >
                            Delete
                          </TabPillButton>
                        </>
                      )}
                    <TabPillButton onClick={() => setAddColumnOpen(true)}>
                      <Plus className="h-3.5 w-3.5" />
                      Add Column
                    </TabPillButton>
                  </div>
                }
              />
            )}
            {readOnly && (
              <div className="flex h-10 shrink-0 items-center bg-gray-50 px-4 md:px-10">
                <span className="text-xs font-medium text-gray-500">
                  Read-only
                </span>
              </div>
            )}

            <TableScrollArea
              header={
                <TableHeaderRow className="md:pr-10">
                  <TableStickyCell header widthClassName={NAME_COL_W}>
                    {visibleColumns.length > 0 ? (
                      <input
                        type="checkbox"
                        checked={
                          selectedColIndices.length === visibleColumns.length
                        }
                        ref={(el) => {
                          if (el)
                            el.indeterminate =
                              selectedColIndices.length > 0 &&
                              selectedColIndices.length < visibleColumns.length;
                        }}
                        onChange={() => {
                          columnSelectionAnchorRef.current = null;
                          setSelectedColIndices(
                            selectedColIndices.length === visibleColumns.length
                              ? []
                              : visibleColumns.map((column) => column.index),
                          );
                        }}
                        className={TABLE_CHECKBOX_CLASS}
                      />
                    ) : (
                      <span
                        className="mr-3 h-2.5 w-2.5 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span>Column Title</span>
                  </TableStickyCell>
                  <TableHeaderCell className="ml-auto w-36">
                    Format
                  </TableHeaderCell>
                  <TableHeaderCell
                    className={
                      readOnly ? PROMPT_COL_W : PROMPT_HEADER_WITH_ACTIONS_W
                    }
                  >
                    Prompt
                  </TableHeaderCell>
                </TableHeaderRow>
              }
            >
              {visibleColumns.length === 0 ? (
                <TableEmptyState>
                  <EmptyState
                    icon={<TabularReviewSkeuoIcon />}
                    title="Columns"
                    description="Add columns to define what this tabular review workflow extracts from each document."
                    action={
                      !readOnly && (
                        <PillButton
                          tone="black"
                          size="sm"
                          onClick={() => setAddColumnOpen(true)}
                          className="px-3"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add Column
                        </PillButton>
                      )
                    }
                  />
                </TableEmptyState>
              ) : (
                <TableBody>
                  {visibleColumns.map((col) => {
                    const FormatIcon = formatIcon(col.format ?? "text");
                    const isChecked = selectedColIndices.includes(col.index);
                    return (
                      <TableRow
                        key={col.index}
                        selected={isChecked}
                        onClick={(event) => {
                          if (event.shiftKey) {
                            event.preventDefault();
                            const anchorIndex =
                              columnSelectionAnchorRef.current;
                            setSelectedColIndices((current) =>
                              selectedIdsAfterRangeClick(
                                col.index,
                                visibleColumns.map((column) => column.index),
                                current,
                                anchorIndex,
                              ),
                            );
                            columnSelectionAnchorRef.current = col.index;
                            return;
                          }
                          if (event.ctrlKey || event.metaKey) {
                            event.preventDefault();
                            setSelectedColIndices((current) =>
                              selectedIdsAfterShiftClick(col.index, current),
                            );
                            columnSelectionAnchorRef.current = col.index;
                            return;
                          }
                          setExpandedPromptIndex(null);
                          if (readOnly) setViewingColumn(col);
                          else setEditingColumn(col);
                        }}
                        className="md:pr-10"
                      >
                        <TablePrimaryCell
                          widthClassName={NAME_COL_W}
                          selected={isChecked}
                          onSelectionChange={() =>
                            setSelectedColIndices((previous) => {
                              columnSelectionAnchorRef.current = col.index;
                              return previous.includes(col.index)
                                ? previous.filter(
                                    (index) => index !== col.index,
                                  )
                                : [...previous, col.index];
                            })
                          }
                          label={col.name}
                        />
                        <TableCell className="ml-auto w-36">
                          <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
                            <FormatIcon
                              className={`h-3.5 w-3.5 ${formatIconClassName(col.format ?? "text")}`}
                            />
                            {formatLabel(col.format ?? "text")}
                          </span>
                        </TableCell>
                        <TableCell
                          className={`${PROMPT_COL_W} relative !overflow-visible pr-4 text-xs`}
                        >
                          <button
                            type="button"
                            aria-expanded={expandedPromptIndex === col.index}
                            title={
                              expandedPromptIndex === col.index
                                ? "Collapse prompt"
                                : "Expand prompt"
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              setExpandedPromptIndex((current) =>
                                current === col.index ? null : col.index,
                              );
                            }}
                            className="block w-full min-w-0 truncate text-left text-gray-600"
                          >
                            {col.prompt || "—"}
                          </button>
                          {expandedPromptIndex === col.index && (
                            <TRExpandedCellSurface>
                              <button
                                type="button"
                                aria-label="Collapse prompt"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setExpandedPromptIndex(null);
                                }}
                                className="block w-full whitespace-pre-wrap p-3 text-left text-xs leading-relaxed text-gray-700"
                              >
                                {col.prompt || "—"}
                              </button>
                            </TRExpandedCellSurface>
                          )}
                        </TableCell>
                        <div
                          className="flex w-8 shrink-0 justify-end"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <RowActions
                            onView={() => {
                              setExpandedPromptIndex(null);
                              if (readOnly) setViewingColumn(col);
                              else setEditingColumn(col);
                            }}
                            onDelete={
                              readOnly
                                ? undefined
                                : () => {
                                const next = columns
                                  .filter(
                                    (column) => column.index !== col.index,
                                  )
                                  .map((column, index) => ({
                                    ...column,
                                    index,
                                  }));
                                setColumns(next);
                                saveColumns(next);
                                  }
                            }
                          />
                        </div>
                      </TableRow>
                    );
                  })}
                </TableBody>
              )}
            </TableScrollArea>
          </>
        )}
      </div>

      {/* Read-only column view modal */}
      {viewingColumn && (
        <WFColumnViewModal
          col={viewingColumn}
          onClose={() => setViewingColumn(null)}
        />
      )}

      {/* Add column modal */}
      <AddColumnModal
        open={addColumnOpen}
        existingCount={columns.length}
        onClose={() => setAddColumnOpen(false)}
        onAdd={handleColumnsAdded}
      />

      {/* Edit column modal */}
      {editingColumn && (
        <WFEditColumnModal
          column={editingColumn}
          onClose={() => setEditingColumn(null)}
          onSave={handleColumnSaved}
          onDelete={() => {
            const next = columns
              .filter((c) => c.index !== editingColumn.index)
              .map((c, i) => ({ ...c, index: i }));
            setColumns(next);
            saveColumns(next);
            setEditingColumn(null);
          }}
        />
      )}
    </div>
  );
}

function AssistantWorkflowEditorSkeleton() {
  return (
    <>
      <TableToolbar<AssistantTab>
        items={[
          { id: "prompt", label: "Prompt" },
          { id: "assets", label: "Assets" },
        ]}
        active="prompt"
      />
      <div className="mx-4 mb-2 min-h-0 min-w-0 flex-1 md:mx-8 md:mb-3">
        <div className={`h-full px-5 py-4 ${LIQUID_TABLE_SURFACE_CLASS}`}>
          <div className="space-y-3">
            <div className="h-3 w-24 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-gray-100" />
          </div>
          <div className="mt-8 space-y-3">
            <div className="h-3 w-28 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-11/12 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-10/12 animate-pulse rounded bg-gray-100" />
          </div>
          <div className="mt-8 space-y-3">
            <div className="h-3 w-20 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-4/6 animate-pulse rounded bg-gray-100" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-gray-100" />
          </div>
        </div>
      </div>
    </>
  );
}

function TabularWorkflowEditorSkeleton() {
  const titleWidths = ["w-36", "w-44", "w-40", "w-52", "w-48"];
  const promptWidths = ["w-64", "w-80", "w-72", "w-96", "w-60"];

  return (
    <>
      <TableToolbar
        actions={<SkeletonLine className="h-7 w-24 rounded-full" />}
      />
      <TableScrollArea
        header={
          <TableHeaderRow className="md:pr-10">
            <TableStickyCell header hover={false} widthClassName={NAME_COL_W}>
              <SkeletonCheckbox />
              <SkeletonLine className="h-2.5 w-20" />
            </TableStickyCell>
            <TableHeaderCell className="ml-auto w-36">
              <SkeletonLine className="h-2.5 w-14" />
            </TableHeaderCell>
            <TableHeaderCell className={PROMPT_HEADER_WITH_ACTIONS_W}>
              <SkeletonLine className="h-2.5 w-12" />
            </TableHeaderCell>
          </TableHeaderRow>
        }
      >
        <TableBody>
          {[1, 2, 3, 4, 5].map((i) => (
            <TableRow key={i} interactive={false} className="md:pr-10">
              <TableStickyCell hover={false} widthClassName={NAME_COL_W}>
                <div className="flex min-w-0 flex-1 items-center">
                  <SkeletonCheckbox />
                  <SkeletonLine className={`h-3 ${titleWidths[i - 1]}`} />
                </div>
              </TableStickyCell>
              <TableCell className="ml-auto w-36">
                <SkeletonLine className="w-16" />
              </TableCell>
              <TableCell className={`${PROMPT_COL_W} pr-4`}>
                <SkeletonLine className={promptWidths[i - 1]} />
              </TableCell>
              <TableCell className="w-8" />
            </TableRow>
          ))}
        </TableBody>
      </TableScrollArea>
    </>
  );
}
