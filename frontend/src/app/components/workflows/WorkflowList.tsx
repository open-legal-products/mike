"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "lucide-react";
import {
  deleteWorkflow,
  getWorkflowFilterOptions,
  type WorkflowFilterOptions,
  getWorkflowAddon,
  importWorkflowAddon,
  listWorkflowAddons,
} from "@/app/lib/mikeApi";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import { useQueryParamTab } from "@/app/hooks/useQueryParamTab";
import { usePaginatedWorkflows } from "@/app/hooks/usePaginatedWorkflows";
import { deleteTabularReviewsWithConcurrency } from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";
import type { Workflow, WorkflowAddon } from "../shared/types";
import { UseWorkflowModal } from "./UseWorkflowModal";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { TableToolbar } from "../shared/TableToolbar";
import { RowActionMenuItems, RowActions } from "../shared/RowActions";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { SubfolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { LiquidDropdownSurface } from "@/app/components/ui/liquid-dropdown";
import {
  ChatSkeuoIcon,
  TabularReviewSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { workflowDetailPath } from "./workflowRoutes";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { WorkflowAddonPreviewModal } from "./WorkflowAddonPreviewModal";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
  SkeletonCheckbox,
  SkeletonLine,
  TABLE_CHECKBOX_CLASS,
  rowActionSelectionIds,
  selectedIdsAfterRangeClick,
  selectedIdsAfterShiftClick,
  tableTreeCellStyle,
  TableBody,
  TableCell,
  TableEmptyState,
  TableFilters,
  type TableFilterOption,
  TableHeaderCell,
  TableHeaderRow,
  TablePrimaryCell,
  TableRow,
  TableScrollArea,
  type TableSortDirection,
  TableStickyCell,
} from "../shared/TablePrimitive";
import { AccessScopeLabel } from "../shared/AccessScopeLabel";

type WorkflowListTab = "all" | "assistant" | "tabular" | "addons";

const WORKFLOW_TABS: { id: WorkflowListTab; labelKey: string }[] = [
  { id: "all", labelKey: "abaTodos" },
  { id: "assistant", labelKey: "assistente" },
  { id: "tabular", labelKey: "tabular" },
  { id: "addons", labelKey: "abaComplementos" },
];
const WORKFLOW_TAB_IDS = WORKFLOW_TABS.map((tab) => tab.id);

const WORKFLOW_SORT_OPTIONS: { value: TableSortDirection; labelKey: string }[] =
  [
    { value: "asc", labelKey: "ordenarCrescente" },
    { value: "desc", labelKey: "ordenarDecrescente" },
  ];
type AccessFilter = "private" | "shared";
const ACCESS_FILTER_OPTIONS: { value: AccessFilter; labelKey: string }[] = [
  { value: "private", labelKey: "privado" },
  { value: "shared", labelKey: "compartilhado" },
];

function workflowFilterOptions(
  values: (string | null | undefined)[],
  labelForValue: (value: string) => string = (value) => value,
): TableFilterOption<string>[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => !!value),
    ),
  )
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, label: labelForValue(value) }));
}

export function WorkflowList({
  initialTab = "all",
  packKey = null,
}: {
  initialTab?: WorkflowListTab;
  packKey?: string | null;
}) {
  const router = useRouter();
  const t = useTranslations("workflows.lista");
  const searchParams = useSearchParams();
  const [addons, setAddons] = useState<WorkflowAddon[]>([]);
  const [addonsLoading, setAddonsLoading] = useState(true);
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useQueryParamTab(
    WORKFLOW_TAB_IDS,
    packKey ? "addons" : initialTab,
    !!packKey || initialTab === "addons",
  );
  const [search, setSearch] = useState("");
  const [nameSortDirection, setNameSortDirection] =
    useState<TableSortDirection | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [practiceFilter, setPracticeFilter] = useState<string | null>(null);
  const [jurisdictionFilter, setJurisdictionFilter] = useState<string | null>(
    null,
  );
  const [languageFilter, setLanguageFilter] = useState<string | null>(null);
  const [accessFilter, setAccessFilter] = useState<AccessFilter | null>(null);
  const [databaseFilterOptions, setDatabaseFilterOptions] =
    useState<WorkflowFilterOptions>({
      practices: [],
      jurisdictions: [],
      languages: [],
    });
  const [selectedAddon, setSelectedAddon] = useState<WorkflowAddon | null>(
    null,
  );
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>([]);
  const [workflowActionsOpen, setWorkflowActionsOpen] = useState(false);
  const [pendingDeleteWorkflows, setPendingDeleteWorkflows] = useState<
    Workflow[]
  >([]);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const [deleteStatus, setDeleteStatus] = useState<
    "idle" | "loading" | "complete"
  >("idle");
  const [importingAddonId, setImportingAddonId] = useState<string | null>(null);
  const [importedAddonIds, setImportedAddonIds] = useState<string[]>([]);
  const [bulkImportingAddons, setBulkImportingAddons] = useState(false);
  const [addonsError, setAddonsError] = useState("");
  const [actionError, setActionError] = useState("");
  const workflowActionsRef = useRef<HTMLDivElement>(null);
  const openAddonIdRef = useRef<string | null>(null);
  const previewEmptyStates = searchParams.get("emptyStates") === "1";
  const debouncedSearch = useDebouncedValue(search, 250);
  const selectedType =
    activeTab === "assistant" || activeTab === "tabular"
      ? activeTab
      : typeFilter === "assistant" || typeFilter === "tabular"
        ? typeFilter
        : undefined;
  const {
    dbWorkflows: workflows,
    setDbWorkflows: setWorkflows,
    loading: workflowsLoading,
    loadingMore,
    hasMore,
    error: workflowsError,
    loadMoreError,
    loadMore,
    selectedWorkflowIds,
    setSelectedWorkflowIds,
    selectAllMatching,
    selectingAll,
  } = usePaginatedWorkflows({
    dbEnabled: activeTab !== "addons",
    systemEnabled: false,
    type: selectedType,
    search: debouncedSearch,
    selectionKey: search,
    practiceFilter,
    languageFilter,
    jurisdictionFilter,
    scope:
      accessFilter === "private"
        ? "private"
        : accessFilter === "shared"
          ? "collaborative"
          : "all",
    sort: nameSortDirection
      ? { key: "name", direction: nameSortDirection }
      : null,
  });
  const loading = activeTab === "addons" ? addonsLoading : workflowsLoading;

  useEffect(() => {
    listWorkflowAddons()
      .then(setAddons)
      .catch((error) => {
        setAddonsError(userFacingApiError(error, t("erroCarregarComplementos")));
      })
      .finally(() => setAddonsLoading(false));
  }, []);

  useEffect(() => {
    if (activeTab === "addons") return;
    const controller = new AbortController();
    void getWorkflowFilterOptions({
      type: selectedType,
      signal: controller.signal,
    })
      .then((options) => {
        if (!controller.signal.aborted) setDatabaseFilterOptions(options);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDatabaseFilterOptions({
            practices: [],
            jurisdictions: [],
            languages: [],
          });
        }
      });
    return () => controller.abort();
  }, [activeTab, selectedType]);

  useEffect(() => {
    function closeActions(event: MouseEvent) {
      if (
        workflowActionsRef.current &&
        !workflowActionsRef.current.contains(event.target as Node)
      ) {
        setWorkflowActionsOpen(false);
      }
    }
    if (workflowActionsOpen) {
      document.addEventListener("mousedown", closeActions);
    }
    return () => document.removeEventListener("mousedown", closeActions);
  }, [workflowActionsOpen]);

  const query = search.trim().toLowerCase();
  const visibleWorkflows = useMemo(() => {
    return previewEmptyStates ? [] : workflows;
  }, [previewEmptyStates, workflows]);

  const visibleAddons = useMemo(() => {
    if (previewEmptyStates) return [];
    return addons.filter(
      (addon) =>
        !query ||
        addon.title.toLowerCase().includes(query) ||
        addon.description?.toLowerCase().includes(query) ||
        addon.pack_title?.toLowerCase().includes(query) ||
        addon.practice?.toLowerCase().includes(query),
    );
  }, [addons, previewEmptyStates, query]);
  const activePack = useMemo(() => {
    if (!packKey) return null;
    const addon = addons.find((item) => item.pack_key === packKey);
    if (!addon) return null;
    return {
      key: packKey,
      title: addon.pack_title || packKey,
    };
  }, [addons, packKey]);

  function openAddonPack(nextPackKey: string) {
    setSearch("");
    setSelectedAddonIds([]);
    setActiveTab(
      "addons",
      `/workflows/addons/packs/${encodeURIComponent(nextPackKey)}`,
    );
  }

  function closeAddonPack() {
    setSelectedAddonIds([]);
    setActiveTab("addons", "/workflows/addons");
  }

  function changeTab(tab: WorkflowListTab) {
    if (tab !== "all") setTypeFilter(null);
    setSelectedWorkflowIds([]);
    setSelectedAddonIds([]);
    setWorkflowActionsOpen(false);

    if (tab === "addons") {
      if (packKey) closeAddonPack();
      else if (initialTab !== "addons") {
        setActiveTab("addons", "/workflows/addons");
      } else {
        setActiveTab("addons");
      }
      return;
    }

    if (packKey || initialTab === "addons") {
      setActiveTab(tab, "/workflows");
    } else {
      setActiveTab(tab);
    }
  }

  async function openAddon(addon: WorkflowAddon) {
    openAddonIdRef.current = addon.id;
    setSelectedAddon(addon);
    try {
      const detailed = await getWorkflowAddon(addon.id);
      if (openAddonIdRef.current === addon.id) setSelectedAddon(detailed);
    } catch {
      // The list payload still provides a useful preview.
    }
  }

  function closeAddon() {
    openAddonIdRef.current = null;
    setSelectedAddon(null);
  }

  async function importAddon(addon: WorkflowAddon) {
    if (importingAddonId || importedAddonIds.includes(addon.id)) return;
    setImportingAddonId(addon.id);
    setActionError("");
    try {
      const workflow = await importWorkflowAddon(addon.id);
      setWorkflows((current) => [workflow, ...current]);
      setImportedAddonIds((current) => [...new Set([...current, addon.id])]);
      setSelectedAddonIds((current) => current.filter((id) => id !== addon.id));
      closeAddon();
    } catch (error) {
      setActionError(
        userFacingApiError(error, t("erroImportar", { titulo: addon.title })),
      );
    } finally {
      setImportingAddonId(null);
    }
  }

  async function importSelectedAddons() {
    const selectedAddons = addons.filter((addon) =>
      selectedAddonIds.includes(addon.id),
    );
    if (selectedAddons.length === 0) return;
    setBulkImportingAddons(true);
    try {
      const results = await Promise.allSettled(
        selectedAddons.map((addon) => importWorkflowAddon(addon.id)),
      );
      const imported = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      if (imported.length > 0) {
        setWorkflows((current) => [...imported, ...current]);
        setImportedAddonIds((current) => [
          ...new Set([
            ...current,
            ...selectedAddons.flatMap((addon, index) =>
              results[index]?.status === "fulfilled" ? [addon.id] : [],
            ),
          ]),
        ]);
      }
      setSelectedAddonIds([]);
      if (imported.length !== selectedAddons.length) {
        setActionError(t("erroImportarLote"));
      }
    } finally {
      setBulkImportingAddons(false);
    }
  }

  function requestWorkflowDeletion(
    workflowsToDelete: Workflow[],
    ids = workflowsToDelete.map((workflow) => workflow.id),
  ) {
    setPendingDeleteWorkflows(workflowsToDelete);
    setPendingDeleteIds(ids);
    setWorkflowActionsOpen(false);
    setDeleteStatus("idle");
  }

  async function confirmWorkflowDeletion() {
    const ids = pendingDeleteIds;
    if (ids.length === 0) return;
    setDeleteStatus("loading");
    const snapshot = workflows;
    setWorkflows((current) =>
      current.filter((workflow) => !ids.includes(workflow.id)),
    );
    const { deletedIds, failedIds } = await deleteTabularReviewsWithConcurrency(
      ids,
      deleteWorkflow,
    );
    setSelectedWorkflowIds((current) =>
      current.filter((id) => !deletedIds.includes(id)),
    );
    if (failedIds.length > 0) {
      setWorkflows((current) =>
        restoreOptimisticallyDeletedRows(current, snapshot, failedIds),
      );
      setActionError(t("erroExcluirLote"));
    }
    setDeleteStatus("complete");
    window.setTimeout(() => {
      setPendingDeleteWorkflows([]);
      setPendingDeleteIds([]);
      setDeleteStatus("idle");
    }, 500);
  }

  const workflowToolbarActions =
    activeTab !== "addons" && selectedWorkflowIds.length > 0 ? (
      <div ref={workflowActionsRef} className="relative">
        <TabPillButton onClick={() => setWorkflowActionsOpen((open) => !open)}>
          {t("acoes")}
          <ChevronDown className="h-3.5 w-3.5" />
        </TabPillButton>
        {workflowActionsOpen && (
          <LiquidDropdownSurface className="absolute top-full right-0 z-[100] mt-1 w-36 overflow-hidden">
            <button
              type="button"
              onClick={() =>
                requestWorkflowDeletion(
                  workflows.filter((workflow) =>
                    selectedWorkflowIds.includes(workflow.id),
                  ),
                  selectedWorkflowIds,
                )
              }
              className="w-full px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-500/10"
            >
              {t("excluir")}
            </button>
          </LiquidDropdownSurface>
        )}
      </div>
    ) : undefined;
  const addonToolbarActions =
    activeTab === "addons" && selectedAddonIds.length > 0 ? (
      <PillButton
        tone="black"
        size="sm"
        disabled={bulkImportingAddons}
        onClick={() => void importSelectedAddons()}
      >
        <Plus className="h-3.5 w-3.5" />
        {bulkImportingAddons
          ? t("importando")
          : selectedAddonIds.length > 1
            ? t("importarComContagem", { count: selectedAddonIds.length })
            : t("importar")}
      </PillButton>
    ) : undefined;
  const pendingDefaultDeleteCount = pendingDeleteWorkflows.filter(
    (workflow) => workflow.is_default,
  ).length;
  const includesUnloadedWorkflows =
    pendingDeleteIds.length > pendingDeleteWorkflows.length;
  const deleteWarningMessage = includesUnloadedWorkflows
    ? t("avisoExcluirNaoCarregados")
    : pendingDefaultDeleteCount > 0
      ? pendingDeleteWorkflows.length === 1
        ? t("avisoExcluirPadraoUnico")
        : t("avisoExcluirPadroes", { count: pendingDefaultDeleteCount })
      : pendingDeleteWorkflows.length === 1
        ? t("avisoExcluirUnico")
        : t("avisoExcluirVarios");

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        shrink
        loading={loading}
        breadcrumbs={
          packKey
            ? [
                {
                  label: t("titulo"),
                  onClick: () => router.push("/workflows"),
                },
                { label: t("abaComplementos"), onClick: closeAddonPack },
                {
                  label: activePack?.title || packKey,
                  loading: addonsLoading && !activePack,
                },
              ]
            : undefined
        }
        actions={[
          {
            type: "search",
            value: search,
            onChange: setSearch,
            placeholder:
              activeTab === "addons"
                ? t("buscarComplementos")
                : t("buscar"),
          },
          {
            type: "new",
            onClick: () => setNewModalOpen(true),
            title: t("novoFluxo"),
          },
        ]}
      >
        <h1 className="font-serif text-2xl font-medium text-gray-900">
          {t("titulo")}
        </h1>
      </PageHeader>

      <TableToolbar
        items={
          packKey
            ? []
            : WORKFLOW_TABS.map(({ id, labelKey }) => ({
                id,
                label: t(labelKey),
              }))
        }
        active={activeTab}
        onChange={changeTab}
        leading={
          packKey ? (
            <TabPillButton onClick={closeAddonPack}>
              <ChevronLeft className="h-3.5 w-3.5" />
              {t("voltar")}
            </TabPillButton>
          ) : undefined
        }
        actions={
          activeTab === "addons" ? addonToolbarActions : workflowToolbarActions
        }
      />

      {actionError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-red-100 bg-red-50 px-6 py-2 text-sm text-red-600"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError("")}
            className="shrink-0 text-xs font-medium text-red-500 hover:text-red-700"
          >
            {t("dispensar")}
          </button>
        </div>
      )}

      {activeTab === "addons" ? (
        <AddonTable
          addons={visibleAddons}
          loading={loading}
          error={addonsError}
          selectedIds={selectedAddonIds}
          onSelectedIdsChange={setSelectedAddonIds}
          importingAddonId={importingAddonId}
          importedAddonIds={importedAddonIds}
          bulkImporting={bulkImportingAddons}
          activePackKey={packKey}
          onOpenPack={openAddonPack}
          onOpen={openAddon}
          onImport={importAddon}
        />
      ) : (
        <WorkflowTable
          key={activeTab}
          workflows={visibleWorkflows}
          loading={loading}
          error={workflowsError ? t("erroCarregarFluxos") : ""}
          onOpen={setSelected}
          onEdit={(workflow) => router.push(workflowDetailPath(workflow))}
          onDelete={(workflow) => requestWorkflowDeletion([workflow])}
          onDeleteSelected={(ids) =>
            requestWorkflowDeletion(
              workflows.filter((workflow) => ids.includes(workflow.id)),
              ids,
            )
          }
          onCreate={() => setNewModalOpen(true)}
          selectedIds={selectedWorkflowIds}
          onSelectedIdsChange={setSelectedWorkflowIds}
          onSelectAll={() => {
            if (accessFilter) {
              setSelectedWorkflowIds(
                visibleWorkflows
                  .filter((workflow) => workflow.is_owner !== false)
                  .map((workflow) => workflow.id),
              );
              return;
            }
            void selectAllMatching([], "owned");
          }}
          selectingAll={selectingAll}
          nameSortDirection={nameSortDirection}
          onNameSortDirectionChange={setNameSortDirection}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          practiceFilter={practiceFilter}
          onPracticeFilterChange={setPracticeFilter}
          jurisdictionFilter={jurisdictionFilter}
          onJurisdictionFilterChange={setJurisdictionFilter}
          languageFilter={languageFilter}
          onLanguageFilterChange={setLanguageFilter}
          accessFilter={accessFilter}
          onAccessFilterChange={setAccessFilter}
          filterOptions={databaseFilterOptions}
          loadingMore={loadingMore}
          hasMore={hasMore}
          loadMoreError={!!loadMoreError}
          onLoadMore={() => void loadMore()}
        />
      )}

      <UseWorkflowModal workflow={selected} onClose={() => setSelected(null)} />

      <NewWorkflowModal
        open={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        onCreated={(workflow) => {
          setWorkflows((current) => [workflow, ...current]);
          setNewModalOpen(false);
          router.push(workflowDetailPath(workflow));
        }}
      />

      <WorkflowAddonPreviewModal
        addon={selectedAddon}
        importing={selectedAddon?.id === importingAddonId}
        onClose={closeAddon}
        onImport={importAddon}
      />

      <ConfirmPopup
        open={pendingDeleteIds.length > 0}
        title={
          pendingDeleteIds.length === 1
            ? t("excluirFluxoTitulo")
            : t("excluirFluxosTitulo")
        }
        message={deleteWarningMessage}
        confirmLabel={t("excluir")}
        confirmVariant="danger"
        confirmStatus={deleteStatus}
        onConfirm={() => void confirmWorkflowDeletion()}
        onCancel={() => {
          if (deleteStatus === "loading") return;
          setPendingDeleteWorkflows([]);
          setPendingDeleteIds([]);
          setDeleteStatus("idle");
        }}
      />
    </div>
  );
}

function WorkflowTable({
  workflows,
  loading,
  error,
  onOpen,
  onEdit,
  onDelete,
  onDeleteSelected,
  onCreate,
  selectedIds,
  onSelectedIdsChange,
  onSelectAll,
  selectingAll,
  nameSortDirection,
  onNameSortDirectionChange,
  typeFilter,
  onTypeFilterChange,
  practiceFilter,
  onPracticeFilterChange,
  jurisdictionFilter,
  onJurisdictionFilterChange,
  languageFilter,
  onLanguageFilterChange,
  accessFilter,
  onAccessFilterChange,
  filterOptions,
  loadingMore,
  hasMore,
  loadMoreError,
  onLoadMore,
}: {
  workflows: Workflow[];
  loading: boolean;
  error: string;
  onOpen: (workflow: Workflow) => void;
  onEdit: (workflow: Workflow) => void;
  onDelete: (workflow: Workflow) => void;
  onDeleteSelected: (ids: string[]) => void;
  onCreate: () => void;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  onSelectAll: () => void;
  selectingAll: boolean;
  nameSortDirection: TableSortDirection | null;
  onNameSortDirectionChange: (direction: TableSortDirection | null) => void;
  typeFilter: string | null;
  onTypeFilterChange: (value: string | null) => void;
  practiceFilter: string | null;
  onPracticeFilterChange: (value: string | null) => void;
  jurisdictionFilter: string | null;
  onJurisdictionFilterChange: (value: string | null) => void;
  languageFilter: string | null;
  onLanguageFilterChange: (value: string | null) => void;
  accessFilter: AccessFilter | null;
  onAccessFilterChange: (value: AccessFilter | null) => void;
  filterOptions: WorkflowFilterOptions;
  loadingMore: boolean;
  hasMore: boolean;
  loadMoreError: boolean;
  onLoadMore: () => void;
}) {
  const rowSelectionAnchorIdRef = useRef<string | null>(null);
  const t = useTranslations("workflows.lista");
  const typeOptions = useMemo<TableFilterOption<string>[]>(
    () => [
      { value: "assistant", label: t("assistente") },
      { value: "tabular", label: t("tabular") },
    ],
    [t],
  );
  const practiceOptions = useMemo(
    () => workflowFilterOptions(filterOptions.practices),
    [filterOptions.practices],
  );
  const jurisdictionOptions = useMemo(
    () => workflowFilterOptions(filterOptions.jurisdictions),
    [filterOptions.jurisdictions],
  );
  const languageOptions = useMemo(
    () => workflowFilterOptions(filterOptions.languages),
    [filterOptions.languages],
  );
  const displayedWorkflows = workflows;
  const selectableIds = displayedWorkflows
    .filter((workflow) => workflow.is_owner !== false)
    .map((workflow) => workflow.id);
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedIds.includes(id));
  const someSelected =
    !allSelected && selectableIds.some((id) => selectedIds.includes(id));

  function toggleAll() {
    rowSelectionAnchorIdRef.current = null;
    if (allSelected) {
      onSelectedIdsChange([]);
      return;
    }
    onSelectAll();
  }

  function toggleOne(id: string) {
    rowSelectionAnchorIdRef.current = id;
    onSelectedIdsChange(
      selectedIds.includes(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id],
    );
  }

  function handleNameSortChange(direction: TableSortDirection | null) {
    rowSelectionAnchorIdRef.current = null;
    onNameSortDirectionChange(direction);
    onSelectedIdsChange([]);
  }

  function handleFilterChange<T extends string>(
    setter: (value: T | null) => void,
    value: T | null,
  ) {
    rowSelectionAnchorIdRef.current = null;
    setter(value);
    onSelectedIdsChange([]);
  }

  return (
    <TableScrollArea
      onScroll={(event) => {
        if (loading || loadingMore || !hasMore) return;
        const element = event.currentTarget;
        const distanceToBottom =
          element.scrollHeight - element.scrollTop - element.clientHeight;
        if (distanceToBottom < 200) onLoadMore();
      }}
      header={
        <TableHeaderRow>
          <TableStickyCell header>
            {loading ? (
              <SkeletonCheckbox />
            ) : (
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = someSelected;
                }}
                disabled={selectableIds.length === 0 || selectingAll}
                onChange={toggleAll}
                className={TABLE_CHECKBOX_CLASS}
                title={t("selecionarTodosExcluiveis")}
              />
            )}
            <span className="mr-1">{t("colNome")}</span>
            {!loading && (
              <TableFilters
                label={t("ordenarPorNome")}
                value={nameSortDirection}
                allLabel={t("ordemPadrao")}
                widthClassName="w-40"
                align="right"
                options={WORKFLOW_SORT_OPTIONS.map(({ value, labelKey }) => ({
                  value,
                  label: t(labelKey),
                }))}
                onChange={handleNameSortChange}
              />
            )}
          </TableStickyCell>
          <TableHeaderCell className="ml-auto w-32">
            <span className="mr-1">{t("colAcesso")}</span>
            {!loading && (
              <TableFilters
                label={t("filtrarPorAcesso")}
                value={accessFilter}
                allLabel={t("todosAcessos")}
                widthClassName="w-40"
                options={ACCESS_FILTER_OPTIONS.map(({ value, labelKey }) => ({
                  value,
                  label: t(labelKey),
                }))}
                onChange={(value) =>
                  handleFilterChange(onAccessFilterChange, value)
                }
              />
            )}
          </TableHeaderCell>
          <TableHeaderCell className="flex w-28 items-center gap-1">
            <span>{t("colTipo")}</span>
            {!loading && (
              <TableFilters
                label={t("filtrarPorTipo")}
                value={typeFilter}
                allLabel={t("todosTipos")}
                widthClassName="w-40"
                options={typeOptions}
                onChange={(value) =>
                  handleFilterChange(onTypeFilterChange, value)
                }
              />
            )}
          </TableHeaderCell>
          <TableHeaderCell className="flex w-52 items-center gap-1">
            <span>{t("colAreaDePratica")}</span>
            {!loading && (
              <TableFilters
                label={t("filtrarPorArea")}
                value={practiceFilter}
                allLabel={t("todasAsAreas")}
                widthClassName="w-52"
                options={practiceOptions}
                onChange={(value) =>
                  handleFilterChange(onPracticeFilterChange, value)
                }
              />
            )}
          </TableHeaderCell>
          <TableHeaderCell className="flex w-40 items-center gap-1">
            <span>{t("colJurisdicao")}</span>
            {!loading && (
              <TableFilters
                label={t("filtrarPorJurisdicao")}
                value={jurisdictionFilter}
                allLabel={t("todasJurisdicoes")}
                widthClassName="w-48"
                options={jurisdictionOptions}
                onChange={(value) =>
                  handleFilterChange(onJurisdictionFilterChange, value)
                }
              />
            )}
          </TableHeaderCell>
          <TableHeaderCell className="flex w-28 items-center gap-1">
            <span>{t("colIdioma")}</span>
            {!loading && (
              <TableFilters
                label={t("filtrarPorIdioma")}
                value={languageFilter}
                allLabel={t("todosIdiomas")}
                widthClassName="w-44"
                options={languageOptions}
                onChange={(value) =>
                  handleFilterChange(onLanguageFilterChange, value)
                }
              />
            )}
          </TableHeaderCell>
          <TableHeaderCell className="w-8" />
        </TableHeaderRow>
      }
    >
      {loading ? (
        <TableBody>
          {[1, 2, 3].map((index) => (
            <TableRow key={index} interactive={false}>
              <TableStickyCell hover={false}>
                <SkeletonCheckbox />
                <SkeletonLine className="h-3.5 w-48" />
              </TableStickyCell>
              <TableCell className="ml-auto w-32">
                <SkeletonLine className="w-16" />
              </TableCell>
              <TableCell className="w-28">
                <SkeletonLine className="w-16" />
              </TableCell>
              <TableCell className="w-52">
                <SkeletonLine className="w-24" />
              </TableCell>
              <TableCell className="w-40">
                <SkeletonLine className="w-24" />
              </TableCell>
              <TableCell className="w-28">
                <SkeletonLine className="w-16" />
              </TableCell>
              <div className="flex w-8 shrink-0 justify-end">
                <div className="h-6 w-6 rounded bg-gray-100 animate-pulse" />
              </div>
            </TableRow>
          ))}
        </TableBody>
      ) : workflows.length === 0 ? (
        <TableEmptyState>
          <EmptyState
            icon={<WorkflowSkeuoIcon />}
            title={t("titulo")}
            description={error || t("criarOuImportar")}
            action={
              <PillButton tone="black" size="sm" onClick={onCreate}>
                {t("criar")}
              </PillButton>
            }
          />
        </TableEmptyState>
      ) : displayedWorkflows.length === 0 ? (
        <TableEmptyState>
          <EmptyState
            icon={<WorkflowSkeuoIcon />}
            title={t("nenhumCorrespondente")}
            description={t("ajustarFiltros")}
          />
        </TableEmptyState>
      ) : (
        <>
          <TableBody>
            {displayedWorkflows.map((workflow) => {
              const Icon =
                workflow.metadata.type === "tabular"
                  ? TabularReviewSkeuoIcon
                  : ChatSkeuoIcon;
              const canManage = workflow.is_owner !== false;
              const canDelete = canManage;
              const isSelected = selectedIds.includes(workflow.id);
              const actionIds = rowActionSelectionIds(workflow.id, selectedIds);
              const appliesToSelection = actionIds.length > 1;
              return (
                <TableRow
                  key={workflow.id}
                  selected={isSelected}
                  onClick={(event) => {
                    if (event.shiftKey) {
                      event.preventDefault();
                      if (canManage) {
                        const anchorId = rowSelectionAnchorIdRef.current;
                        onSelectedIdsChange(
                          selectedIdsAfterRangeClick(
                            workflow.id,
                            selectableIds,
                            selectedIds,
                            anchorId,
                          ),
                        );
                        rowSelectionAnchorIdRef.current = workflow.id;
                      }
                      return;
                    }
                    if (event.ctrlKey || event.metaKey) {
                      event.preventDefault();
                      if (canManage) {
                        onSelectedIdsChange(
                          selectedIdsAfterShiftClick(workflow.id, selectedIds),
                        );
                        rowSelectionAnchorIdRef.current = workflow.id;
                      }
                      return;
                    }
                    onOpen(workflow);
                  }}
                  rightClickDropdown={(close, menuProps) => (
                    <RowActionMenuItems
                      onClose={close}
                      surfaceProps={menuProps}
                      onView={
                        appliesToSelection ? undefined : () => onOpen(workflow)
                      }
                      onEditDetails={
                        appliesToSelection || !canManage
                          ? undefined
                          : () => onEdit(workflow)
                      }
                      editDetailsLabel={t("editar")}
                      onDelete={
                        appliesToSelection
                          ? () => onDeleteSelected(actionIds)
                          : canManage
                            ? () => onDelete(workflow)
                            : undefined
                      }
                      deleteLabel={
                        appliesToSelection
                          ? t("excluirVarios", { count: actionIds.length })
                          : undefined
                      }
                    />
                  )}
                >
                  <TablePrimaryCell
                    label={workflow.metadata.title}
                    selected={isSelected}
                    onSelectionChange={() => toggleOne(workflow.id)}
                    selectionIndicator={
                      canDelete ? undefined : (
                        <input
                          type="checkbox"
                          disabled
                          className={TABLE_CHECKBOX_CLASS}
                          title={t("compartilhadosNaoExcluem")}
                          aria-label={t("selecionar", {
                            titulo: workflow.metadata.title,
                          })}
                        />
                      )
                    }
                  />
                  <TableCell className="ml-auto w-32">
                    <AccessScopeLabel
                      scope={
                        workflow.access_scope ??
                        (workflow.org_id
                          ? "organization"
                          : workflow.is_owner === false
                            ? "shared"
                            : "private")
                      }
                      organizationName={workflow.organization_name}
                      directGrantCount={workflow.direct_grant_count}
                    />
                  </TableCell>
                  <TableCell className="w-28">
                    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
                      <Icon className="h-3 w-3 shrink-0" />
                      {workflow.metadata.type === "tabular"
                        ? t("tabular")
                        : t("assistente")}
                    </span>
                  </TableCell>
                  <TableCell className="w-52 text-xs text-gray-600">
                    {workflow.metadata.practice || "—"}
                  </TableCell>
                  <TableCell className="w-40 truncate text-xs text-gray-600">
                    {workflow.metadata.jurisdictions?.join(", ") || "—"}
                  </TableCell>
                  <TableCell className="w-28 text-xs text-gray-600">
                    {workflow.metadata.language || "—"}
                  </TableCell>
                  <div
                    className="flex w-8 shrink-0 justify-end"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <RowActions
                      onView={() => onOpen(workflow)}
                      onEditDetails={
                        canManage ? () => onEdit(workflow) : undefined
                      }
                      editDetailsLabel={t("editar")}
                      onDelete={
                        canManage ? () => onDelete(workflow) : undefined
                      }
                    />
                  </div>
                </TableRow>
              );
            })}
          </TableBody>
          <TableLoadMoreRow
            loading={loading}
            hasMore={hasMore}
            itemCount={displayedWorkflows.length}
            loadingMore={loadingMore}
            hasError={loadMoreError}
            onLoadMore={onLoadMore}
          />
        </>
      )}
    </TableScrollArea>
  );
}

function AddonTable({
  addons,
  loading,
  error,
  selectedIds,
  onSelectedIdsChange,
  importingAddonId,
  importedAddonIds,
  bulkImporting,
  activePackKey,
  onOpenPack,
  onOpen,
  onImport,
}: {
  addons: WorkflowAddon[];
  loading: boolean;
  error: string;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  importingAddonId: string | null;
  importedAddonIds: string[];
  bulkImporting: boolean;
  activePackKey: string | null;
  onOpenPack: (packKey: string) => void;
  onOpen: (addon: WorkflowAddon) => void;
  onImport: (addon: WorkflowAddon) => Promise<void>;
}) {
  const [expandedPackKeys, setExpandedPackKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const t = useTranslations("workflows.lista");
  const rowSelectionAnchorIdRef = useRef<string | null>(null);
  const packs = useMemo(() => {
    const grouped = new Map<
      string,
      {
        key: string;
        title: string;
        description: string | null;
        addons: WorkflowAddon[];
      }
    >();
    for (const addon of addons) {
      if (!addon.pack_key) continue;
      const existing = grouped.get(addon.pack_key);
      if (existing) {
        existing.addons.push(addon);
      } else {
        grouped.set(addon.pack_key, {
          key: addon.pack_key,
          title: addon.pack_title || addon.pack_key,
          description: addon.pack_description,
          addons: [addon],
        });
      }
    }
    return [...grouped.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [addons]);
  const activePack = activePackKey
    ? (packs.find((pack) => pack.key === activePackKey) ?? null)
    : null;
  const standaloneAddons = addons.filter((addon) => !addon.pack_key);
  const isEmpty = activePackKey
    ? !activePack || activePack.addons.length === 0
    : packs.length === 0 && standaloneAddons.length === 0;
  const addonIds = (activePack?.addons ?? addons).map((addon) => addon.id);
  const allSelected =
    addonIds.length > 0 && addonIds.every((id) => selectedIds.includes(id));
  const someSelected =
    !allSelected && addonIds.some((id) => selectedIds.includes(id));

  function toggleAll() {
    rowSelectionAnchorIdRef.current = null;
    onSelectedIdsChange(allSelected ? [] : addonIds);
  }

  function toggleOne(addonId: string) {
    rowSelectionAnchorIdRef.current = addonId;
    onSelectedIdsChange(
      selectedIds.includes(addonId)
        ? selectedIds.filter((id) => id !== addonId)
        : [...selectedIds, addonId],
    );
  }

  function togglePackSelection(packAddons: WorkflowAddon[]) {
    const packIds = packAddons.map((addon) => addon.id);
    rowSelectionAnchorIdRef.current = packIds[0] ?? null;
    const packSelected = packIds.every((id) => selectedIds.includes(id));
    onSelectedIdsChange(
      packSelected
        ? selectedIds.filter((id) => !packIds.includes(id))
        : [...new Set([...selectedIds, ...packIds])],
    );
  }

  function togglePack(packKey: string) {
    setExpandedPackKeys((current) => {
      const next = new Set(current);
      if (next.has(packKey)) next.delete(packKey);
      else next.add(packKey);
      return next;
    });
  }

  function renderAddonRow(addon: WorkflowAddon, nested = false) {
    const Icon =
      addon.type === "tabular" ? TabularReviewSkeuoIcon : ChatSkeuoIcon;
    const imported = importedAddonIds.includes(addon.id);
    const importing = importingAddonId === addon.id;
    return (
      <TableRow
        key={addon.id}
        selected={selectedIds.includes(addon.id)}
        onClick={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
            const anchorId = rowSelectionAnchorIdRef.current;
            onSelectedIdsChange(
              selectedIdsAfterRangeClick(
                addon.id,
                addonIds,
                selectedIds,
                anchorId,
              ),
            );
            rowSelectionAnchorIdRef.current = addon.id;
            return;
          }
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            onSelectedIdsChange(
              selectedIdsAfterShiftClick(addon.id, selectedIds),
            );
            rowSelectionAnchorIdRef.current = addon.id;
            return;
          }
          onOpen(addon);
        }}
      >
        <TablePrimaryCell
          style={nested ? tableTreeCellStyle(1) : undefined}
          label={addon.title}
          selected={selectedIds.includes(addon.id)}
          onSelectionChange={() => toggleOne(addon.id)}
        />
        <TableCell className="ml-auto w-28">
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
            <Icon className="h-3 w-3 shrink-0" />
            {addon.type === "tabular" ? t("tabular") : t("assistente")}
          </span>
        </TableCell>
        <TableCell className="w-52 text-xs text-gray-600">
          {addon.practice || "—"}
        </TableCell>
        <TableCell className="w-40 truncate text-xs text-gray-600">
          {addon.jurisdictions?.join(", ") || "—"}
        </TableCell>
        <TableCell className="w-28 text-xs text-gray-600">
          {addon.language || "—"}
        </TableCell>
        <TableCell className="w-20">
          <button
            type="button"
            disabled={bulkImporting || importing || imported}
            onClick={(event) => {
              event.stopPropagation();
              void onImport(addon);
            }}
            className={`inline-flex items-center gap-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
              imported
                ? "text-green-600"
                : "text-gray-600 hover:text-gray-950 disabled:text-gray-400"
            }`}
          >
            {imported ? <Check className="h-3.5 w-3.5" /> : null}
            {imported ? t("importado") : importing ? t("importando") : t("importar")}
          </button>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableScrollArea
      header={
        <TableHeaderRow>
          <TableStickyCell header>
            {loading ? (
              <SkeletonCheckbox />
            ) : (
              <input
                type="checkbox"
                checked={allSelected}
                ref={(element) => {
                  if (element) element.indeterminate = someSelected;
                }}
                disabled={addonIds.length === 0 || bulkImporting}
                onChange={toggleAll}
                className={TABLE_CHECKBOX_CLASS}
                title={t("selecionarTodosComplementos")}
              />
            )}
            {t("colNome")}
          </TableStickyCell>
          <TableHeaderCell className="ml-auto w-28">
            {t("colTipo")}
          </TableHeaderCell>
          <TableHeaderCell className="w-52">
            {t("colAreaDePratica")}
          </TableHeaderCell>
          <TableHeaderCell className="w-40">
            {t("colJurisdicao")}
          </TableHeaderCell>
          <TableHeaderCell className="w-28">
            {t("colIdioma")}
          </TableHeaderCell>
          <TableHeaderCell className="w-20" />
        </TableHeaderRow>
      }
    >
      {loading ? (
        <TableBody>
          {[1, 2, 3].map((index) => (
            <TableRow key={index} interactive={false}>
              <TableStickyCell hover={false}>
                <SkeletonCheckbox />
                <SkeletonLine className="h-3.5 w-48" />
              </TableStickyCell>
              <TableCell className="ml-auto flex w-28 items-center">
                <div className="mr-1.5 h-4 w-4 shrink-0 rounded bg-gray-100 animate-pulse" />
                <SkeletonLine className="w-14" />
              </TableCell>
              <TableCell className="w-52">
                <SkeletonLine className="w-24" />
              </TableCell>
              <TableCell className="w-40">
                <SkeletonLine className="w-24" />
              </TableCell>
              <TableCell className="w-28">
                <SkeletonLine className="w-16" />
              </TableCell>
              <TableCell className="w-20">
                <SkeletonLine className="w-14" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      ) : isEmpty ? (
        <TableEmptyState>
          <EmptyState
            icon={<WorkflowSkeuoIcon />}
            title={t("abaComplementos")}
            description={
              error ||
              (activePackKey ? t("pacoteVazio") : t("nenhumComplemento"))
            }
          />
        </TableEmptyState>
      ) : (
        <TableBody>
          {activePack ? (
            activePack.addons.map((addon) => renderAddonRow(addon))
          ) : (
            <>
              {packs.map((pack) => {
                const expanded = expandedPackKeys.has(pack.key);
                const packSelected = pack.addons.every((addon) =>
                  selectedIds.includes(addon.id),
                );
                const packPartiallySelected =
                  !packSelected &&
                  pack.addons.some((addon) => selectedIds.includes(addon.id));
                return [
                  <TableRow
                    key={`${pack.key}:folder`}
                    selected={packSelected}
                    aria-expanded={expanded}
                    onClick={(event) => {
                      const packIds = pack.addons.map((addon) => addon.id);
                      const anchorId = packIds[0] ?? null;
                      if (event.shiftKey) {
                        event.preventDefault();
                        onSelectedIdsChange([
                          ...new Set([
                            ...selectedIds,
                            ...(anchorId
                              ? selectedIdsAfterRangeClick(
                                  anchorId,
                                  addonIds,
                                  [],
                                  rowSelectionAnchorIdRef.current,
                                )
                              : []),
                            ...packIds,
                          ]),
                        ]);
                        rowSelectionAnchorIdRef.current = anchorId;
                        return;
                      }
                      if (event.ctrlKey || event.metaKey) {
                        event.preventDefault();
                        onSelectedIdsChange([
                          ...new Set([...selectedIds, ...packIds]),
                        ]);
                        rowSelectionAnchorIdRef.current = anchorId;
                        return;
                      }
                      onOpenPack(pack.key);
                    }}
                  >
                    <TablePrimaryCell
                      selected={packSelected}
                      onSelectionChange={() => togglePackSelection(pack.addons)}
                      selectionIndicator={
                        <input
                          type="checkbox"
                          checked={packSelected}
                          ref={(element) => {
                            if (element) {
                              element.indeterminate = packPartiallySelected;
                            }
                          }}
                          disabled={bulkImporting}
                          onChange={() => togglePackSelection(pack.addons)}
                          onClick={(event) => event.stopPropagation()}
                          className={TABLE_CHECKBOX_CLASS}
                          title={t("selecionar", { titulo: pack.title })}
                          aria-label={t("selecionar", { titulo: pack.title })}
                        />
                      }
                      label={
                        <span className="flex min-w-0 items-center">
                          <button
                            type="button"
                            aria-label={
                              expanded
                                ? t("recolherPacote", { titulo: pack.title })
                                : t("expandirPacote", { titulo: pack.title })
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              togglePack(pack.key);
                            }}
                            className="mr-2 flex h-4 w-4 shrink-0 items-center justify-center"
                          >
                            {expanded ? (
                              <ChevronDown className="h-4 w-4 text-gray-400" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-gray-400" />
                            )}
                          </button>
                          <SubfolderSvgIcon
                            open={expanded}
                            className="mr-2 h-4 w-4 shrink-0"
                          />
                          <span className="truncate text-xs text-gray-700">
                            {pack.title}
                          </span>
                        </span>
                      }
                    />
                    <TableCell className="ml-auto w-28 text-xs text-gray-600">
                      {t("pacote")}
                    </TableCell>
                    <TableCell className="w-52 text-xs text-gray-600">
                      {t("pacoteFluxos", { count: pack.addons.length })}
                    </TableCell>
                    <TableCell className="w-40 text-xs text-gray-600">
                      —
                    </TableCell>
                    <TableCell className="w-28 text-xs text-gray-600">
                      —
                    </TableCell>
                    <TableCell className="w-20" />
                  </TableRow>,
                  ...(expanded
                    ? pack.addons.map((addon) => renderAddonRow(addon, true))
                    : []),
                ];
              })}
              {standaloneAddons.map((addon) => renderAddonRow(addon))}
            </>
          )}
        </TableBody>
      )}
    </TableScrollArea>
  );
}
