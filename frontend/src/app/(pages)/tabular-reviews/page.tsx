"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useDebouncedValue } from "@/app/hooks/useDebouncedValue";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Loader2 } from "lucide-react";
import {
    RowActionMenuItems,
    RowActions,
} from "@/app/components/shared/RowActions";
import { TableLoadMoreRow } from "@/app/components/shared/TableLoadMoreRow";
import {
    deleteTabularReview,
    createTabularReview,
    getTabularReviewPeople,
    grantTabularReviewAccess,
    listProjects,
    updateTabularReview,
} from "@/app/lib/mikeApi";
import type { TabularReview, Project } from "@/app/components/shared/types";
import { TableToolbar } from "@/app/components/shared/TableToolbar";
import { NewTRModal } from "@/app/components/tabular/NewTRModal";
import { TabularReviewDetailsModal } from "@/app/components/tabular/TabularReviewDetailsModal";
import {
    PermissionDeniedPopup,
    type AccessContact,
} from "@/app/components/popups/PermissionDeniedPopup";
import { can, roleFrom } from "@/app/lib/permissions";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { useAuth } from "@/app/contexts/AuthContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    TABLE_CHECKBOX_CLASS,
    SkeletonCheckbox,
    SkeletonLine,
    TableBody,
    TableCell,
    TableEmptyState,
    TableFilters,
    TableHeaderCell,
    TableHeaderRow,
    TablePrimaryCell,
    TableRow,
    TableScrollArea,
    rowActionSelectionIds,
    type TableSortDirection,
    TableStickyCell,
} from "@/app/components/shared/TablePrimitive";
import { PillButton } from "@/app/components/ui/pill-button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { TabularReviewSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { LiquidDropdownSurface } from "@/app/components/ui/liquid-dropdown";
import {
    type TabularReviewScope,
    usePaginatedTabularReviews,
} from "@/app/hooks/usePaginatedTabularReviews";
import { deleteTabularReviewsWithConcurrency } from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { useQueryParamTab } from "@/app/hooks/useQueryParamTab";

type ReviewScope = TabularReviewScope;
type ReviewSortKey = "name" | "columns" | "documents" | "created";

const REVIEW_SCOPES: { id: ReviewScope; labelKey: string }[] = [
    { id: "all", labelKey: "tabTodas" },
    { id: "in-project", labelKey: "tabEmProjeto" },
    { id: "standalone", labelKey: "tabIndependente" },
];
const REVIEW_SCOPE_IDS = REVIEW_SCOPES.map((scope) => scope.id);
const SORT_OPTIONS: { value: TableSortDirection; labelKey: string }[] = [
    { value: "asc", labelKey: "ordenacaoCrescente" },
    { value: "desc", labelKey: "ordenacaoDecrescente" },
];
function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

export default function TabularReviewsPage() {
    const t = useTranslations("pages.revisoesTabulares");
    const tPermissao = useTranslations("popups.permissao");
    const router = useRouter();
    const searchParams = useSearchParams();
    const [projects, setProjects] = useState<Project[]>([]);
    const [creating, setCreating] = useState(false);
    const [newTROpen, setNewTROpen] = useState(false);
    const [detailsReview, setDetailsReview] = useState<TabularReview | null>(
        null,
    );
    const [activeScope, setActiveScope] = useQueryParamTab(
        REVIEW_SCOPE_IDS,
        "all",
    );
    const [projectFilter, setProjectFilter] = useState<string | null>(null);
    const [sort, setSort] = useState<{
        key: ReviewSortKey;
        direction: TableSortDirection;
    } | null>(null);
    const [search, setSearch] = useState("");
    const debouncedSearch = useDebouncedValue(search, 250);
    const {
        reviews,
        setReviews,
        loading,
        loadingMore,
        hasMore,
        error: loadError,
        loadMoreError,
        loadMore,
        retry,
        selectedReviewIds: selectedIds,
        setSelectedReviewIds: setSelectedIds,
        selectAllMatching,
        selectingAll,
        getReviewOwnerId,
    } = usePaginatedTabularReviews({
        projectId: projectFilter ?? undefined,
        search: debouncedSearch,
        selectionKey: search,
        scope: activeScope,
        sort,
    });
    const [actionsOpen, setActionsOpen] = useState(false);
    /**
     * A refusal plus the person who can lift it. Unlike the projects overview,
     * the reviews overview RPC returns no contact columns at all — only
     * `access_role` — so the address is fetched from
     * `/tabular-review/:id/people` the first time a refusal actually fires,
     * exactly as TabularReviewView does for a standalone review. The popup
     * opens immediately and the "ask …" line fills in when the roster
     * answers; a refusal that names nobody is a dead end.
     */
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<{
        reviewId: string;
        action: string;
        requiredRole: "owner" | "editor";
    } | null>(null);
    const [contactsByReviewId, setContactsByReviewId] = useState<
        Record<string, AccessContact[]>
    >({});
    const [selectionCameFromSelectAll, setSelectionCameFromSelectAll] =
        useState(false);
    const [confirmDeleteAllOpen, setConfirmDeleteAllOpen] = useState(false);
    const [bulkDeleteNotice, setBulkDeleteNotice] = useState<string | null>(
        null,
    );
    const [deletingReviewIds, setDeletingReviewIds] = useState<Set<string>>(
        () => new Set(),
    );
    const actionsRef = useRef<HTMLDivElement>(null);
    const { user } = useAuth();
    const previewEmptyStates = searchParams.get("emptyStates") === "1";
    const effectiveLoading = loading && !previewEmptyStates;
    const visibleReviews = useMemo(
        () => (previewEmptyStates ? [] : reviews),
        [previewEmptyStates, reviews],
    );

    useEffect(() => {
        let cancelled = false;
        void listProjects()
            .then((loadedProjects) => {
                if (!cancelled) setProjects(loadedProjects);
            })
            .catch(() => {
                if (!cancelled) setProjects([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    function handleLoadMore() {
        void loadMore();
    }

    function handleScroll(event: React.UIEvent<HTMLDivElement>) {
        if (loading || loadingMore || !hasMore) return;
        const el = event.currentTarget;
        const distanceToBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceToBottom < 200) void loadMore();
    }

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            ) {
                setActionsOpen(false);
            }
        }
        if (actionsOpen) document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [actionsOpen]);

    const projectNameById = useMemo(
        () => new Map(projects.map((project) => [project.id, project.name])),
        [projects],
    );
    const filtered = visibleReviews;

    const allSelected =
        filtered.length > 0 &&
        filtered.every((r) => selectedIds.includes(r.id));
    const someSelected =
        !allSelected && filtered.some((r) => selectedIds.includes(r.id));

    function toggleAll() {
        if (allSelected) {
            setSelectedIds([]);
            setSelectionCameFromSelectAll(false);
        } else {
            setSelectionCameFromSelectAll(true);
            void selectAllMatching();
        }
    }

    function toggleOne(id: string) {
        setSelectedIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
        );
    }

    function clearSelection() {
        setSelectedIds([]);
        setSelectionCameFromSelectAll(false);
        setConfirmDeleteAllOpen(false);
        setActionsOpen(false);
    }

    function handleProjectFilterChange(value: string | null) {
        setProjectFilter(value);
        clearSelection();
    }

    function handleSortChange(
        key: ReviewSortKey,
        direction: TableSortDirection | null,
    ) {
        setSort(direction ? { key, direction } : null);
        clearSelection();
    }

    const handleNewReview = async (
        title: string,
        projectId: string | undefined,
        documentIds: string[] | undefined,
        columnsConfig:
            | import("@/app/components/shared/types").ColumnConfig[]
            | null
            | undefined,
        documentGrouping: "document" | "folder" | undefined,
        model: string,
        accessAssignments: {
            email: string;
            role: import("@/app/lib/mikeApi").AccessAssignmentRole;
        }[],
    ) => {
        setCreating(true);
        try {
            const review = await createTabularReview({
                title,
                document_ids: documentIds ?? [],
                columns_config: columnsConfig ?? [],
                document_grouping: documentGrouping,
                model,
                ...(projectId && { project_id: projectId }),
            });
            for (const assignment of accessAssignments) {
                await grantTabularReviewAccess(
                    review.id,
                    assignment.email,
                    assignment.role,
                );
            }
            router.push(
                projectId
                    ? `/projects/${projectId}/tabular-reviews/${review.id}`
                    : `/tabular-reviews/${review.id}`,
            );
        } finally {
            setCreating(false);
        }
    };

    /**
     * Refuse an action on one review, and make sure the popup can say who to
     * ask. The roster is fetched once per review and cached, so repeated
     * refusals on the same row cost nothing.
     */
    function refuse(
        reviewId: string,
        action: string,
        requiredRole: "owner" | "editor" = "owner",
    ) {
        setOwnerOnlyAction({ reviewId, action, requiredRole });
        if (contactsByReviewId[reviewId]) return;
        void getTabularReviewPeople(reviewId)
            .then((people) => {
                setContactsByReviewId((prev) => ({
                    ...prev,
                    [reviewId]: people.owner ? [people.owner] : [],
                }));
            })
            .catch(() => {
                // A roster we cannot read just means no name to offer; the
                // refusal itself still stands.
                setContactsByReviewId((prev) => ({ ...prev, [reviewId]: [] }));
            });
    }

    function requestReviewDetails(review: TabularReview) {
        // The overview RPC now returns each row's merged access_role. Details
        // editing is member-tier — the server's PATCH asks for content.edit —
        // so the refusal must say "member", not "admin" (the review page and
        // this list previously disagreed about the same action).
        if (!can(roleFrom(review), "content.edit")) {
            refuse(
                review.id,
                tPermissao("acaoEditarDetalhesRevisao"),
                "editor",
            );
            return;
        }
        setDetailsReview(review);
    }

    async function handleDetailsSave(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (!detailsReview) return;
        if (!can(roleFrom(detailsReview), "content.edit")) {
            refuse(
                detailsReview.id,
                tPermissao("acaoEditarDetalhesRevisao"),
                "editor",
            );
            return;
        }
        const updated = await updateTabularReview(detailsReview.id, {
            title: values.title,
            project_id: values.projectId ?? null,
        });
        setReviews((prev) =>
            prev.map((review) =>
                review.id === updated.id ? { ...review, ...updated } : review,
            ),
        );
        setDetailsReview((current) =>
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

    async function handleDeleteSelected() {
        const ids = [...selectedIds];
        setActionsOpen(false);
        setConfirmDeleteAllOpen(false);
        setSelectionCameFromSelectAll(false);
        setBulkDeleteNotice(null);
        // Prefer the loaded row's role; select-all-matching can hand back
        // ids that were never paged in, and for those the creator id is the
        // only signal available.
        const roleById = new Map(
            reviews.map((review) => [review.id, roleFrom(review)] as const),
        );
        const owned = ids.filter((id) => {
            const role = roleById.get(id);
            if (role) return can(role, "container.delete");
            // Fail closed on rows we could not load. `!user?.id ||` made an
            // unknown viewer identity pass every creator check, so a signed-in
            // state that had not settled yet turned select-all-matching into
            // "delete everything selected". Both halves must be known and
            // must match; anything else is counted as blocked and reported.
            const ownerId = getReviewOwnerId(id);
            return !!ownerId && !!user?.id && ownerId === user.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedIds([]);
        const snapshot = reviews;
        setReviews((current) =>
            current.filter((review) => !owned.includes(review.id)),
        );
        const { failedIds } =
            await deleteTabularReviewsWithConcurrency(
                owned,
                deleteTabularReview,
            );
        setSelectedIds(failedIds);
        if (failedIds.length > 0) {
            setReviews((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, failedIds),
            );
        }
        const notices = [
            blocked > 0 ? t("avisoIgnoradas", { count: blocked }) : null,
            failedIds.length > 0
                ? t("avisoFalhaExclusao", { count: failedIds.length })
                : null,
        ].filter((notice): notice is string => notice !== null);
        if (notices.length > 0) setBulkDeleteNotice(notices.join(" "));
    }

    async function handleDeleteReviewRow(review: TabularReview) {
        if (!can(roleFrom(review), "container.delete")) {
            refuse(review.id, tPermissao("acaoExcluirRevisao"));
            return;
        }
        const snapshot = reviews;
        setDeletingReviewIds((current) => new Set(current).add(review.id));
        setReviews((current) =>
            current.filter((candidate) => candidate.id !== review.id),
        );
        try {
            await deleteTabularReview(review.id);
        } catch (error) {
            setReviews((current) =>
                restoreOptimisticallyDeletedRows(current, snapshot, [review.id]),
            );
            throw error;
        } finally {
            setDeletingReviewIds((current) => {
                const next = new Set(current);
                next.delete(review.id);
                return next;
            });
        }
    }

    const sortOptions = SORT_OPTIONS.map(({ value, labelKey }) => ({
        value,
        label: t(labelKey),
    }));

    const projectFilterButton = (
        <TableFilters
            label={t("filtrarPorProjeto")}
            value={projectFilter}
            allLabel={t("todosProjetos")}
            options={projects.map((project) => ({
                value: project.id,
                label: project.name,
            }))}
            onChange={handleProjectFilterChange}
        />
    );
    const nameSortDirection = sort?.key === "name" ? sort.direction : null;
    const columnsSortDirection =
        sort?.key === "columns" ? sort.direction : null;
    const documentsSortDirection =
        sort?.key === "documents" ? sort.direction : null;
    const createdSortDirection =
        sort?.key === "created" ? sort.direction : null;
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
    const columnsFilterButton = (
        <TableFilters
            label={t("ordenarPorColunas")}
            value={columnsSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            options={sortOptions}
            onChange={(direction) => handleSortChange("columns", direction)}
        />
    );
    const documentsFilterButton = (
        <TableFilters
            label={t("ordenarPorDocumentos")}
            value={documentsSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            options={sortOptions}
            onChange={(direction) => handleSortChange("documents", direction)}
        />
    );
    const createdFilterButton = (
        <TableFilters
            label={t("ordenarPorCriadoEm")}
            value={createdSortDirection}
            allLabel={t("ordemPadrao")}
            widthClassName="w-40"
            options={sortOptions}
            onChange={(direction) => handleSortChange("created", direction)}
        />
    );

    const toolbarActions =
        selectedIds.length > 0 ? (
            <div ref={actionsRef} className="relative">
                <TabPillButton onClick={() => setActionsOpen((v) => !v)}>
                    {t("acoes")}
                    <ChevronDown className="h-3.5 w-3.5" />
                </TabPillButton>
                {actionsOpen && (
                    <LiquidDropdownSurface className="absolute top-full right-0 mt-1 z-[100] w-36 overflow-hidden">
                        <button
                            onClick={requestDeleteSelected}
                            className="w-full px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-500/10"
                        >
                            {t("excluir")}
                        </button>
                    </LiquidDropdownSurface>
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
                        onClick: () => setNewTROpen(true),
                        loading: creating,
                        title: t("novaRevisaoTabular"),
                    },
                ]}
            >
                <h1 className="text-2xl font-medium font-serif text-gray-900">
                    {t("titulo")}
                </h1>
            </PageHeader>

            <TableToolbar
                items={REVIEW_SCOPES.map(({ id, labelKey }) => ({
                    id,
                    label: t(labelKey),
                }))}
                active={activeScope}
                onChange={(scope) => {
                    setActiveScope(scope);
                    clearSelection();
                }}
                actions={toolbarActions}
            />

            {/* Table */}
            <TableScrollArea
                onScroll={handleScroll}
                header={
                    <TableHeaderRow>
                        <TableStickyCell header>
                            {effectiveLoading ? (
                                <SkeletonCheckbox />
                            ) : (
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    disabled={
                                        selectingAll ||
                                        deletingReviewIds.size > 0
                                    }
                                    ref={(el) => {
                                        if (el) el.indeterminate = someSelected;
                                    }}
                                    onChange={toggleAll}
                                    className={TABLE_CHECKBOX_CLASS}
                                    aria-label={t("selecionarTodas")}
                                />
                            )}
                            <span className="mr-1">{t("colNome")}</span>
                            {!loading && nameFilterButton}
                        </TableStickyCell>
                        <TableHeaderCell className="ml-auto w-24">
                            <div className="flex items-center gap-1">
                                <span>{t("colColunas")}</span>
                                {!loading && columnsFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-24">
                            <div className="flex items-center gap-1">
                                <span>{t("colDocumentos")}</span>
                                {!loading && documentsFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-52">
                            <div className="flex items-center gap-1">
                                <span>{t("colProjeto")}</span>
                                {!loading && projectFilterButton}
                            </div>
                        </TableHeaderCell>
                        <TableHeaderCell className="w-32">
                            <div className="flex items-center gap-1">
                                <span>{t("colCriadoEm")}</span>
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
                                    <SkeletonLine className="h-3.5 w-48" />
                                </TableStickyCell>
                                <TableCell className="ml-auto w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-24">
                                    <SkeletonLine className="w-8" />
                                </TableCell>
                                <TableCell className="w-52">
                                    <SkeletonLine className="w-24" />
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
                        <p className="text-lg font-medium font-serif text-gray-900">
                            {t("erroCarregarTitulo")}
                        </p>
                        <p className="mt-1 text-xs text-gray-400">
                            {t("erroCarregarDescricao")}
                        </p>
                        <PillButton
                            tone="black"
                            size="sm"
                            onClick={retry}
                            className="mt-4"
                        >
                            {t("tentarNovamente")}
                        </PillButton>
                    </TableEmptyState>
                ) : filtered.length === 0 ? (
                    <TableEmptyState>
                        {activeScope === "all" &&
                        !projectFilter &&
                        !debouncedSearch ? (
                            <>
                                <TabularReviewSkeuoIcon className="mb-4 h-8 w-8" />
                                <p className="text-2xl font-medium font-serif text-gray-900">
                                    {t("tituloVazio")}
                                </p>
                                <p className="mt-1 text-xs text-gray-400 max-w-xs text-left">
                                    {t("descricaoVazio")}
                                </p>
                                <PillButton
                                    tone="black"
                                    size="sm"
                                    onClick={() => setNewTROpen(true)}
                                    disabled={creating}
                                    className="mt-4"
                                >
                                    {t("criar")}
                                </PillButton>
                            </>
                        ) : (
                            <p className="text-sm text-gray-400">
                                {t("nenhumaEncontrada")}
                            </p>
                        )}
                    </TableEmptyState>
                ) : (
                    <TableBody>
                        {filtered.map((review) => {
                            const projectName = review.project_id
                                ? projectNameById.get(review.project_id)
                                : null;
                            const deleting = deletingReviewIds.has(review.id);
                            const actionIds = rowActionSelectionIds(
                                review.id,
                                selectedIds,
                            );
                            const appliesToSelection = actionIds.length > 1;
                            return (
                                <TableRow
                                    key={review.id}
                                    interactive={!deleting}
                                    selected={
                                        !deleting &&
                                        selectedIds.includes(review.id)
                                    }
                                    rightClickDropdown={
                                        deleting
                                            ? undefined
                                            : (close, menuProps) => (
                                                  <RowActionMenuItems
                                                      onClose={close}
                                                      surfaceProps={menuProps}
                                                      onView={
                                                          appliesToSelection
                                                              ? undefined
                                                              : () =>
                                                                    router.push(
                                                                        review.project_id
                                                                            ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                                                                            : `/tabular-reviews/${review.id}`,
                                                                    )
                                                      }
                                                      viewLabel={t("abrir")}
                                                      onEditDetails={
                                                          appliesToSelection
                                                              ? undefined
                                                              : () => {
                                                                    requestReviewDetails(
                                                                        review,
                                                                    );
                                                                }
                                                      }
                                                      onDelete={() =>
                                                          appliesToSelection
                                                              ? requestDeleteSelected()
                                                              : handleDeleteReviewRow(
                                                                    review,
                                                                )
                                                      }
                                                       deleteLabel={
                                                           appliesToSelection
                                                               ? t(
                                                                     "excluirSelecionadas",
                                                                     {
                                                                         count: actionIds.length,
                                                                     },
                                                                 )
                                                               : undefined
                                                       }
                                                  />
                                              )
                                    }
                                    onClick={
                                        deleting
                                            ? undefined
                                            : () => {
                                                  router.push(
                                                      review.project_id
                                                          ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                                                          : `/tabular-reviews/${review.id}`,
                                                  );
                                              }
                                    }
                                    className={
                                        deleting
                                            ? "pointer-events-none opacity-50"
                                            : undefined
                                    }
                                >
                                    <TablePrimaryCell
                                                selected={
                                                    !deleting &&
                                                    selectedIds.includes(
                                                        review.id,
                                                    )
                                                }
                                        selectionIndicator={
                                            deleting ? (
                                                <Loader2 className="mr-4 h-3 w-3 shrink-0 animate-spin text-gray-400" />
                                            ) : undefined
                                        }
                                        onSelectionChange={() =>
                                            toggleOne(review.id)
                                        }
                                         label={
                                             review.title ?? t("semTitulo")
                                         }
                                    />
                                    <TableCell className="ml-auto w-24">
                                        {review.columns_config?.length ?? 0}
                                    </TableCell>
                                    <TableCell className="w-24">
                                        {review.document_count ?? 0}
                                    </TableCell>
                                    <TableCell className="w-52 pr-2">
                                        {projectName ? (
                                            projectName
                                        ) : (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell className="w-32">
                                        {review.created_at ? (
                                            formatDate(review.created_at)
                                        ) : (
                                            <span className="text-gray-300">
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <div
                                        className="w-8 shrink-0 flex justify-end"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <RowActions
                                            onView={() =>
                                                router.push(
                                                    review.project_id
                                                        ? `/projects/${review.project_id}/tabular-reviews/${review.id}`
                                                        : `/tabular-reviews/${review.id}`,
                                                )
                                            }
                                            viewLabel={t("abrir")}
                                            onEditDetails={() => {
                                                requestReviewDetails(review);
                                            }}
                                            onDelete={() =>
                                                handleDeleteReviewRow(review)
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
                    itemCount={filtered.length}
                    loadingMore={loadingMore}
                    hasError={!!loadMoreError}
                    onLoadMore={handleLoadMore}
                />
            </TableScrollArea>

            <NewTRModal
                open={newTROpen}
                onClose={() => setNewTROpen(false)}
                onAdd={handleNewReview}
                projects={projects}
            />

            <TabularReviewDetailsModal
                open={!!detailsReview}
                review={detailsReview}
                projects={projects}
                canEdit={
                    !!detailsReview &&
                    can(roleFrom(detailsReview), "content.edit")
                }
                onClose={() => setDetailsReview(null)}
                onSave={handleDetailsSave}
            />

            <PermissionDeniedPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction?.action}
                requiredRole={ownerOnlyAction?.requiredRole}
                contacts={
                    ownerOnlyAction
                        ? contactsByReviewId[ownerOnlyAction.reviewId]
                        : null
                }
                onClose={() => setOwnerOnlyAction(null)}
            />
            <WarningPopup
                open={!!bulkDeleteNotice}
                title={t("avisoNaoExcluidasTitulo")}
                message={bulkDeleteNotice}
                onClose={() => setBulkDeleteNotice(null)}
            />
            <ConfirmPopup
                open={confirmDeleteAllOpen && selectedIds.length > 0}
                title={t("confirmarExcluirTodasTitulo")}
                message={t("confirmarExcluirTodasMensagem", {
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
