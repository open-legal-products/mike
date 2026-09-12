"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import {
    getProjectFilterOptions,
    type ProjectFilterOptions,
    updateProject,
    deleteProject,
} from "@/app/lib/mikeApi";
import { deleteTabularReviewsWithConcurrency } from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import {
    usePaginatedProjects,
    type ProjectScope,
} from "@/app/hooks/usePaginatedProjects";
import {
    mergeAccessContacts,
    PermissionDeniedPopup,
    type AccessContact,
} from "@/app/components/popups/PermissionDeniedPopup";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { useAuth } from "@/app/contexts/AuthContext";
import type { Project } from "@/app/components/shared/types";
import { can, roleFrom } from "@/app/lib/permissions";
import { NewProjectModal } from "./NewProjectModal";
import { ProjectDetailsModal } from "./ProjectDetailsModal";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import {
    RowActionMenuItems,
    RowActions,
} from "@/app/components/shared/RowActions";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import {
    ClosedProjectSvgIcon,
    OpenProjectSvgIcon,
} from "@/app/components/shared/FolderSvgIcon";
import {
    TABLE_CHECKBOX_CLASS,
    SkeletonCheckbox,
    SkeletonLine,
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
    rowActionSelectionIds,
    selectedIdsAfterRangeClick,
    selectedIdsAfterShiftClick,
    type TableSortDirection,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { useQueryParamTab } from "@/app/hooks/useQueryParamTab";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { AccessScopeLabel } from "@/app/components/shared/AccessScopeLabel";

function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

/**
 * Who created the row. This is provenance, not permission: what the caller may
 * do here comes from `access_role`, which the overview RPC now returns.
 */
function getProjectCreatorLabel(
    project: Project,
    currentUserId: string | null | undefined,
    t: (key: string) => string,
) {
    if (project.is_owner ?? project.user_id === currentUserId)
        return t("criadorEu");
    return (
        project.owner_display_name?.trim() ||
        project.owner_email?.trim() ||
        t("criadorCompartilhado")
    );
}

type ProjectFilter = "all" | "shared" | "private";
type ProjectSortKey = "name" | "cm" | "files" | "chats" | "reviews" | "created";

const SORT_OPTIONS: { value: TableSortDirection; labelKey: string }[] = [
    { value: "asc", labelKey: "ordenarAscendente" },
    { value: "desc", labelKey: "ordenarDescendente" },
];
const PROJECT_FILTERS: { id: ProjectFilter; labelKey: string }[] = [
    { id: "all", labelKey: "tabTodos" },
    { id: "shared", labelKey: "tabCompartilhados" },
    { id: "private", labelKey: "tabPrivados" },
];
const PROJECT_FILTER_IDS = PROJECT_FILTERS.map((filter) => filter.id);
const PROJECT_FILTER_SCOPES: Record<ProjectFilter, ProjectScope> = {
    all: "all",
    shared: "collaborative",
    private: "private",
};
const ACCESS_FILTER_OPTIONS: {
    value: "private" | "shared";
    labelKey: string;
}[] = [
    { value: "private", labelKey: "tabPrivados" },
    { value: "shared", labelKey: "tabCompartilhados" },
];

export function ProjectsOverview() {
    const t = useTranslations("projects.visaoGeral");
    const tPermissao = useTranslations("popups.permissao");
    const router = useRouter();
    const searchParams = useSearchParams();
    const [modalOpen, setModalOpen] = useState(false);
    const [detailsProject, setDetailsProject] = useState<Project | null>(null);
    const [activeFilter, setActiveFilter] = useQueryParamTab(
        PROJECT_FILTER_IDS,
        "all",
    );
    const [practiceFilter, setPracticeFilter] = useState<string | null>(null);
    const [ownerFilter, setOwnerFilter] = useState<string | null>(null);
    const [sort, setSort] = useState<{
        key: ProjectSortKey;
        direction: TableSortDirection;
    } | null>(null);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [search, setSearch] = useState("");
    /**
     * A refusal, together with the people who could lift it. Naming somebody
     * is the whole point of the popup, and it can only do that if the surface
     * raising the refusal hands over the row's `admin_contacts` — which the
     * projects overview RPC returns on every row.
     */
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<{
        action: string;
        contacts?: AccessContact[] | null;
    } | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [selectionCameFromSelectAll, setSelectionCameFromSelectAll] =
        useState(false);
    const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
    const [filterOptions, setFilterOptions] = useState<ProjectFilterOptions>({
        practices: [],
        owners: [],
    });
    const actionsRef = useRef<HTMLDivElement>(null);
    const rowSelectionAnchorIdRef = useRef<string | null>(null);
    const { user, isAuthenticated, authLoading } = useAuth();
    const previewEmptyStates = searchParams.get("emptyStates") === "1";
    const debouncedSearch = useDebouncedValue(search, 250);

    const {
        projects,
        setProjects,
        loading,
        loadingMore,
        hasMore,
        error: loadErrorObj,
        loadMoreError,
        loadMore,
        retry,
        selectedProjectIds: selectedIds,
        setSelectedProjectIds: setSelectedIds,
        selectAllMatching,
        getProjectOwnerId,
    } = usePaginatedProjects({
        search: debouncedSearch,
        selectionKey: search,
        scope: PROJECT_FILTER_SCOPES[activeFilter],
        practiceFilter,
        ownerUserIdFilter: ownerFilter,
        sort,
    });
    const loadError = loadErrorObj ? t("erroCarregar") : null;
    const effectiveLoading = loading && !previewEmptyStates;
    const visibleProjects = useMemo(
        () => (previewEmptyStates ? [] : projects),
        [previewEmptyStates, projects],
    );

    useEffect(() => {
        if (authLoading || !isAuthenticated) return;
        const controller = new AbortController();
        getProjectFilterOptions(controller.signal)
            .then((data) => {
                if (!controller.signal.aborted) setFilterOptions(data);
            })
            .catch(() => {
                // Filter option lists degrade to "no options" — not worth a
                // user-facing error for a purely cosmetic dropdown.
            });
        return () => {
            controller.abort();
        };
    }, [authLoading, isAuthenticated]);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            )
                setActionsOpen(false);
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    const practices = filterOptions.practices;
    const ownerOptions = filterOptions.owners;

    const allSelected =
        visibleProjects.length > 0 &&
        visibleProjects.every((p) => selectedIds.includes(p.id));
    const someSelected =
        !allSelected && visibleProjects.some((p) => selectedIds.includes(p.id));

    function toggleAll() {
        rowSelectionAnchorIdRef.current = null;
        if (allSelected) {
            setSelectedIds([]);
            setSelectionCameFromSelectAll(false);
        } else {
            setSelectionCameFromSelectAll(true);
            void selectAllMatching();
        }
    }

    function toggleOne(id: string) {
        rowSelectionAnchorIdRef.current = id;
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    function clearSelection() {
        rowSelectionAnchorIdRef.current = null;
        setSelectedIds([]);
        setSelectionCameFromSelectAll(false);
        setConfirmDeleteAllOpen(false);
        setActionsOpen(false);
    }

    function handlePracticeFilterChange(value: string | null) {
        setPracticeFilter(value);
        clearSelection();
    }

    function handleOwnerFilterChange(value: string | null) {
        setOwnerFilter(value);
        clearSelection();
    }

    function handleSortChange(
        key: ProjectSortKey,
        direction: TableSortDirection | null,
    ) {
        setSort(direction ? { key, direction } : null);
        clearSelection();
    }

    const nameSortDirection = sort?.key === "name" ? sort.direction : null;
    const cmSortDirection = sort?.key === "cm" ? sort.direction : null;
    const filesSortDirection = sort?.key === "files" ? sort.direction : null;
    const chatsSortDirection = sort?.key === "chats" ? sort.direction : null;
    const reviewsSortDirection =
        sort?.key === "reviews" ? sort.direction : null;
    const createdSortDirection =
        sort?.key === "created" ? sort.direction : null;
    const sortOptions: TableFilterOption<TableSortDirection>[] =
        SORT_OPTIONS.map(({ value, labelKey }) => ({
            value,
            label: t(labelKey),
        }));
    const accessFilterOptions: TableFilterOption<"private" | "shared">[] =
        ACCESS_FILTER_OPTIONS.map(({ value, labelKey }) => ({
            value,
            label: t(labelKey),
        }));
    const nameFilterButton = (
        <TableFilters
            label={t("ordenarPorNome")}
            value={nameSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            align="right"
            options={sortOptions}
            onChange={(direction) => handleSortChange("name", direction)}
        />
    );
    const accessFilterButton = (
        <TableFilters
            label={t("filtrarPorAcesso")}
            value={activeFilter === "all" ? null : activeFilter}
            allLabel={t("todoAcesso")}
            widthClassName="w-40"
            options={accessFilterOptions}
            onChange={(value) => {
                setActiveFilter(value ?? "all");
                clearSelection();
            }}
        />
    );
    const cmFilterButton = (
        <TableFilters
            label={t("ordenarPorReferencia")}
            value={cmSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            options={sortOptions}
            onChange={(direction) => handleSortChange("cm", direction)}
        />
    );
    const practiceFilterButton = (
        <TableFilters
            label={t("filtrarPorArea")}
            value={practiceFilter}
            allLabel={t("todasAsAreas")}
            options={practices.map((practice) => ({
                value: practice,
                label: practice,
            }))}
            onChange={handlePracticeFilterChange}
        />
    );
    const ownerFilterButton = (
        <TableFilters
            label={t("filtrarPorCriador")}
            value={ownerFilter}
            allLabel={t("todosOsCriadores")}
            widthClassName="w-44"
            options={ownerOptions}
            onChange={handleOwnerFilterChange}
        />
    );
    const filesFilterButton = (
        <TableFilters
            label={t("ordenarPorArquivos")}
            value={filesSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            options={sortOptions}
            onChange={(direction) => handleSortChange("files", direction)}
        />
    );
    const chatsFilterButton = (
        <TableFilters
            label={t("ordenarPorConversas")}
            value={chatsSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            options={sortOptions}
            onChange={(direction) => handleSortChange("chats", direction)}
        />
    );
    const reviewsFilterButton = (
        <TableFilters
            label={t("ordenarPorRevisoes")}
            value={reviewsSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            options={sortOptions}
            onChange={(direction) => handleSortChange("reviews", direction)}
        />
    );
    const createdFilterButton = (
        <TableFilters
            label={t("ordenarPorData")}
            value={createdSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            options={sortOptions}
            onChange={(direction) => handleSortChange("created", direction)}
        />
    );

    async function handleProjectDetailsSave(values: {
        name: string;
        cmNumber: string;
        practice: string;
    }) {
        if (!detailsProject) return;
        // The list rows carry the caller's merged access_role, so an
        // organization admin editing a colleague's matter is no longer
        // mistaken for an outsider just because they did not create it.
        if (!can(roleFrom(detailsProject), "access.manage")) {
            setOwnerOnlyAction({
                action: t("ownerEditarDetalhes"),
                contacts: detailsProject.admin_contacts,
            });
            return;
        }
        const name = values.name.trim();
        const cmNumber = values.cmNumber.trim();
        const practice = values.practice.trim();
        if (!name) return;
        const updated = await updateProject(detailsProject.id, {
            name,
            cm_number: cmNumber,
            practice: practice || null,
        });
        setProjects((prev) =>
            prev.map((project) =>
                project.id === updated.id
                    ? { ...project, ...updated }
                    : project,
            ),
        );
        setDetailsProject((current) =>
            current?.id === updated.id ? { ...current, ...updated } : current,
        );
    }

    function requestDeleteSelected() {
        setActionsOpen(false);
        if (selectionCameFromSelectAll) {
            setConfirmDeleteAllOpen(true);
            return;
        }
        void handleDeleteSelected();
    }

    async function handleDeleteProjectRow(project: Project) {
        const snapshot = projects;
        setProjects((current) =>
            current.filter((candidate) => candidate.id !== project.id),
        );
        try {
            await deleteProject(project.id);
        } catch (error) {
            console.error("delete project failed", error);
            setProjects((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, [
                    project.id,
                ]),
            );
            // The row action calls this without awaiting, so rethrowing would
            // only produce an unhandled rejection and a row that reappears
            // with no explanation.
            setActionError(
                userFacingApiError(error, t("erroExcluirProjeto")),
            );
        }
    }

    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setConfirmDeleteAllOpen(false);
        setSelectionCameFromSelectAll(false);
        // Deleting a project needs container.delete, i.e. project admin. The
        // per-row control is already hidden for rows the caller cannot
        // delete, but the bulk action can still pick them up if a user
        // toggled them across filters — or if select-all-matching pulled in
        // ids that were never paged in, which is why creator identity is the
        // fallback when the row itself is not loaded.
        const roleById = new Map(
            projects.map((p) => [p.id, roleFrom(p)] as const),
        );
        const deletable = ids.filter((id) => {
            const role = roleById.get(id);
            if (role) return can(role, "container.delete");
            // Unloaded row: creator identity is all we have, and it has to
            // MATCH. `!creatorId ||` treated "we don't know who created this"
            // as permission to delete it, which is the one answer an unknown
            // must never produce — select-all-matching is exactly the path
            // that hands back ids whose rows were never paged in. A row we
            // cannot vouch for is skipped and counted as blocked, so the user
            // is told rather than silently having it dropped.
            const creatorId = getProjectOwnerId(id);
            return !!creatorId && !!user?.id && creatorId === user.id;
        });
        const blocked = ids.length - deletable.length;
        setSelectedIds([]);
        const snapshot = projects;
        setProjects((current) =>
            current.filter((project) => !deletable.includes(project.id)),
        );
        const { failedIds } = await deleteTabularReviewsWithConcurrency(
            deletable,
            deleteProject,
        );
        if (failedIds.length > 0) {
            setProjects((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, failedIds),
            );
            setSelectedIds(failedIds);
        }
        if (blocked > 0) {
            // Several rows were refused, so offer the union of their admins
            // rather than a refusal that names nobody.
            const blockedContacts = mergeAccessContacts(
                ids
                    .filter((id) => !deletable.includes(id))
                    .map((id) => projects.find((p) => p.id === id))
                    .map((project) => project?.admin_contacts),
            );
            setOwnerOnlyAction({
                action: tPermissao("acaoExcluirProjetosSelecionados", {
                    count: blocked,
                }),
                contacts: blockedContacts,
            });
        }
    }

    const toolbarActions =
        selectedIds.length > 0 ? (
            <div ref={actionsRef} className="relative">
                <TabPillButton onClick={() => setActionsOpen((v) => !v)}>
                    {t("acoes")}
                    <ChevronDown className="h-3.5 w-3.5" />
                </TabPillButton>
                {actionsOpen && (
                    <div
                        className={`absolute right-0 top-full z-[120] mt-1 w-36 overflow-hidden rounded-lg ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`}
                    >
                        <button
                            onClick={requestDeleteSelected}
                            className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                        >
                            {t("excluir")}
                        </button>
                    </div>
                )}
            </div>
        ) : undefined;

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {/* Page header */}
            <PageHeader
                loading={loading}
                actions={[
                    {
                        type: "search",
                        value: search,
                        onChange: setSearch,
                        placeholder: t("buscar"),
                    },
                    {
                        type: "new",
                        onClick: () => setModalOpen(true),
                        title: t("novoProjeto"),
                    },
                ]}
            >
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    {t("titulo")}
                </h1>
            </PageHeader>

            <TableToolbar
                items={PROJECT_FILTERS.map(({ id, labelKey }) => ({
                    id,
                    label: t(labelKey),
                }))}
                active={activeFilter}
                onChange={(nextFilter) => {
                    setActiveFilter(nextFilter);
                    clearSelection();
                }}
                actions={toolbarActions}
            />

            {/* Table */}
            <TableScrollArea
                onScroll={(event) => {
                    if (loading || loadingMore || !hasMore) return;
                    const el = event.currentTarget;
                    const distanceToBottom =
                        el.scrollHeight - el.scrollTop - el.clientHeight;
                    if (distanceToBottom < 200) void loadMore();
                }}
                header={
                    <TableHeaderRow>
                        <TableStickyCell header>
                            {effectiveLoading ? (
                                <SkeletonCheckbox />
                            ) : (
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    ref={(el) => {
                                        if (el) el.indeterminate = someSelected;
                                    }}
                                    onChange={toggleAll}
                                    className={TABLE_CHECKBOX_CLASS}
                                    aria-label={t("selecionarTodosProjetos")}
                                />
                            )}
                            <span className="mr-1">{t("colunaNome")}</span>
                            {!loading && nameFilterButton}
                        </TableStickyCell>
                        <TableHeaderCell className="ml-auto w-32">
                            <span className="mr-1">{t("colunaAcesso")}</span>
                            {!loading && accessFilterButton}
                        </TableHeaderCell>
                        <TableHeaderCell className="w-32">
                            <div className="flex items-center gap-1">
                                <span>{t("colunaReferencia")}</span>
                                {!loading && cmFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-36">
                            <div className="flex items-center gap-1">
                                <span>{t("colunaArea")}</span>
                                {!loading && practiceFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-32">
                            <div className="flex items-center gap-1">
                                <span>{t("colunaCriadoPor")}</span>
                                {!loading && ownerFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-24">
                            <div className="flex items-center gap-1">
                                <span>{t("colunaArquivos")}</span>
                                {!loading && filesFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-24">
                            <div className="flex items-center gap-1">
                                <span>{t("colunaConversas")}</span>
                                {!loading && chatsFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-36">
                            <div className="flex items-center gap-1">
                                <span>{t("colunaRevisoes")}</span>
                                {!loading && reviewsFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-32">
                            <div className="flex items-center gap-1">
                                <span>{t("colunaCriado")}</span>
                                {!loading && createdFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-8" />
                    </TableHeaderRow>
                }
            >
                {effectiveLoading ? (
                    <TableBody>
                        {[1, 2, 3].map((i) => (
                            <TableRow key={i} interactive={false}>
                                <TableStickyCell
                                    hover={false}
                                    bgClassName="bg-transparent"
                                >
                                    <SkeletonCheckbox />
                                    <div className="mr-2 h-4 w-4 shrink-0 rounded bg-gray-100 animate-pulse" />
                                    <SkeletonLine className="h-3.5 w-48" />
                                </TableStickyCell>
                                <TableCell className="ml-auto w-32">
                                    <SkeletonLine className="w-16" />
                                </TableCell>
                                <TableCell className="w-32">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-36">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-32">
                                    <SkeletonLine className="w-16" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-36">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-32">
                                    <SkeletonLine className="w-20" />
                                </TableCell>
                                <TableCell className="w-8" />
                            </TableRow>
                        ))}
                    </TableBody>
                ) : loadError ? (
                    <TableEmptyState>
                        <EmptyState
                            icon={<OpenProjectSvgIcon />}
                            title={t("estadoVazioTitulo")}
                            description={loadError}
                            tone="error"
                            action={
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    onClick={retry}
                                >
                                    {t("tentarNovamente")}
                                </PillButton>
                            }
                        />
                    </TableEmptyState>
                ) : visibleProjects.length === 0 ? (
                    <TableEmptyState>
                        {activeFilter === "shared" ? (
                            <p className="text-sm text-gray-400">
                                {t("nenhumCompartilhado")}
                            </p>
                        ) : (
                            <EmptyState
                                icon={<OpenProjectSvgIcon />}
                                title={t("estadoVazioTitulo")}
                                description={t("estadoVazioDescricao")}
                                action={
                                    <PillButton
                                        tone="black"
                                        size="sm"
                                        onClick={() => setModalOpen(true)}
                                    >
                                        {t("criar")}
                                    </PillButton>
                                }
                            />
                        )}
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {visibleProjects.map((project) => {
                            const actionIds = rowActionSelectionIds(
                                project.id,
                                selectedIds,
                            );
                            const appliesToSelection = actionIds.length > 1;
                            // The list rows carry the caller's merged
                            // access_role, so an organization admin editing a
                            // colleague's matter is no longer mistaken for an
                            // outsider just because they did not create it.
                            const canManage = can(
                                roleFrom(project),
                                "access.manage",
                            );
                            return (
                                <TableRow
                                    key={project.id}
                                    selected={selectedIds.includes(project.id)}
                                    rightClickDropdown={(close, menuProps) => (
                                        <RowActionMenuItems
                                            onClose={close}
                                            surfaceProps={menuProps}
                                            onView={
                                                appliesToSelection
                                                    ? undefined
                                                    : () =>
                                                          router.push(
                                                              `/projects/${project.id}`,
                                                          )
                                            }
                                            viewLabel={t("abrir")}
                                            onEditDetails={
                                                appliesToSelection || !canManage
                                                    ? undefined
                                                    : () => {
                                                          setDetailsProject(
                                                              project,
                                                          );
                                                      }
                                            }
                                            onDelete={
                                                appliesToSelection
                                                    ? requestDeleteSelected
                                                    : canManage
                                                      ? () =>
                                                            handleDeleteProjectRow(
                                                                project,
                                                            )
                                                      : undefined
                                            }
                                            deleteLabel={
                                                appliesToSelection
                                                    ? t("excluirNProjetos", {
                                                          count: actionIds
                                                              .length,
                                                      })
                                                    : undefined
                                            }
                                        />
                                    )}
                                    onClick={(event) => {
                                        if (event.shiftKey) {
                                            event.preventDefault();
                                            const anchorId =
                                                rowSelectionAnchorIdRef.current;
                                            setSelectionCameFromSelectAll(
                                                false,
                                            );
                                            setSelectedIds((current) =>
                                                selectedIdsAfterRangeClick(
                                                    project.id,
                                                    visibleProjects.map(
                                                        (visibleProject) =>
                                                            visibleProject.id,
                                                    ),
                                                    current,
                                                    anchorId,
                                                ),
                                            );
                                            rowSelectionAnchorIdRef.current =
                                                project.id;
                                            return;
                                        }
                                        if (event.ctrlKey || event.metaKey) {
                                            event.preventDefault();
                                            setSelectionCameFromSelectAll(
                                                false,
                                            );
                                            setSelectedIds((current) =>
                                                selectedIdsAfterShiftClick(
                                                    project.id,
                                                    current,
                                                ),
                                            );
                                            rowSelectionAnchorIdRef.current =
                                                project.id;
                                            return;
                                        }
                                        router.push(`/projects/${project.id}`);
                                    }}
                                >
                                    {/* Project Name */}
                                    <TablePrimaryCell
                                        selected={selectedIds.includes(
                                            project.id,
                                        )}
                                        onSelectionChange={() =>
                                            toggleOne(project.id)
                                        }
                                        checkboxTitle={t("selecionarProjeto", {
                                            name: project.name,
                                        })}
                                    >
                                        <ClosedProjectSvgIcon className="mr-2 h-4 w-4 shrink-0" />
                                        <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                                            {project.name}
                                        </span>
                                    </TablePrimaryCell>

                                    <TableCell className="ml-auto w-32">
                                        <AccessScopeLabel
                                            scope={
                                                project.access_scope ??
                                                (project.org_id
                                                    ? "organization"
                                                    : project.is_owner === false
                                                      ? "shared"
                                                      : "private")
                                            }
                                            organizationName={
                                                project.organization_name
                                            }
                                            directGrantCount={
                                                project.direct_grant_count
                                            }
                                        />
                                    </TableCell>
                                    <TableCell className="w-32">
                                        {project.cm_number ?? (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="w-36">
                                        {project.practice ?? (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="w-32">
                                        {getProjectCreatorLabel(
                                            project,
                                            user?.id,
                                            t,
                                        )}
                                    </TableCell>
                                    <TableCell className="w-24">
                                        {project.document_count ?? 0}
                                    </TableCell>
                                    <TableCell className="w-24">
                                        {project.chat_count ?? 0}
                                    </TableCell>
                                    <TableCell className="w-36">
                                        {project.review_count ?? 0}
                                    </TableCell>
                                    <TableCell className="w-32">
                                        {formatDate(project.created_at)}
                                    </TableCell>

                                    <div
                                        className="w-8 shrink-0 flex justify-end"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <RowActions
                                            onView={() =>
                                                router.push(
                                                    `/projects/${project.id}`,
                                                )
                                            }
                                            viewLabel={t("abrir")}
                                            onEditDetails={
                                                canManage
                                                    ? () => {
                                                          setDetailsProject(
                                                              project,
                                                          );
                                                      }
                                                    : undefined
                                            }
                                            onDelete={
                                                canManage
                                                    ? () =>
                                                          handleDeleteProjectRow(
                                                              project,
                                                          )
                                                    : undefined
                                            }
                                        />
                                    </div>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                )}
                <TableLoadMoreRow
                    loading={effectiveLoading}
                    hasMore={hasMore}
                    itemCount={visibleProjects.length}
                    loadingMore={loadingMore}
                    hasError={!!loadMoreError}
                    onLoadMore={() => void loadMore()}
                />
            </TableScrollArea>

            <NewProjectModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                onCreated={(p) => {
                    setProjects((prev) => [p, ...prev]);
                    router.push(`/projects/${p.id}`);
                }}
            />

            <ProjectDetailsModal
                open={!!detailsProject}
                project={detailsProject}
                canEdit={
                    !!detailsProject &&
                    can(roleFrom(detailsProject), "access.manage")
                }
                onClose={() => setDetailsProject(null)}
                onSave={handleProjectDetailsSave}
            />

            <PermissionDeniedPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction?.action}
                contacts={ownerOnlyAction?.contacts}
                onClose={() => setOwnerOnlyAction(null)}
            />
            <WarningPopup
                open={!!actionError}
                message={actionError ?? ""}
                onClose={() => setActionError(null)}
            />
            <ConfirmPopup
                open={confirmDeleteAllOpen && selectedIds.length > 0}
                title={t("tituloExcluirSelecionados")}
                message={t("mensagemExcluirSelecionados", {
                    count: selectedIds.length,
                })}
                confirmLabel={t("excluir")}
                confirmVariant="danger"
                onCancel={() => setConfirmDeleteAllOpen(false)}
                onConfirm={() => void handleDeleteSelected()}
            />
        </div>
    );
}
