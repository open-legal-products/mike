"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
    Plus,
    Loader2,
    Square,
    Play,
    ChevronDown,
    MessageSquare,
    MessageSquareX,
    Download,
    Users,
    Upload,
    X,
    Pencil,
    Trash2,
    WandSparkles,
} from "lucide-react";

import {
    clearTabularCells,
    deleteTabularReview,
    getTabularReview,
    getProject,
    getTabularReviewPeople,
    listProjects,
    regenerateTabularCell,
    streamTabularGeneration,
    updateTabularReview,
    uploadReviewDocument,
    MikeApiError,
} from "@/app/lib/mikeApi";
import type {
    ColumnConfig,
    Document,
    Project,
    TabularCell,
    TabularReview,
    TabularReviewRow,
    Workflow,
} from "../shared/types";
import { AddColumnModal } from "./AddColumnModal";
import { TRWorkflowModal } from "./TRWorkflowModal";
import { AddDocumentsModal } from "../modals/AddDocumentsModal";
import { PeopleModal } from "../modals/PeopleModal";
import { OwnerOnlyPopup } from "../popups/OwnerOnlyPopup";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { WarningPopup } from "../popups/WarningPopup";
import { NoModelsWarningPopup } from "../popups/NoModelsWarningPopup";
import { HeaderActionsMenu } from "../shared/HeaderActionsMenu";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import { TRSidePanel } from "./TRSidePanel";
import { TRTable } from "./TRTable";
import type { TRTableHandle } from "./TRTable";
import { TRChatPanel } from "./TRChatPanel";
import { TabularReviewDetailsModal } from "./TabularReviewDetailsModal";
import { exportTabularReviewToExcel } from "./exportToExcel";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { PageHeader } from "../shared/PageHeader";
import { TableToolbar } from "../shared/TableToolbar";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { LIQUID_GLASS_FLOAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { ModelToggle, type NoModelsReason } from "../assistant/ModelToggle";

interface Props {
    reviewId: string;
    projectId?: string;
}

export function TRView({ reviewId, projectId }: Props) {
    const { setSidebarOpen } = useSidebar();
    const [review, setReview] = useState<TabularReview | null>(null);
    const [project, setProject] = useState<Project | null>(null);
    const [cells, setCells] = useState<TabularCell[]>([]);
    const [documents, setDocuments] = useState<Document[]>([]);
    const [rows, setRows] = useState<TabularReviewRow[]>([]);
    const [columns, setColumns] = useState<ColumnConfig[]>([]);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [stoppingGeneration, setStoppingGeneration] = useState(false);
    const [generationGuard, setGenerationGuard] = useState<
        "running" | "stale" | null
    >(null);
    const [reloadingLatestReview, setReloadingLatestReview] = useState(false);
    const [savingColumn, setSavingColumn] = useState(false);
    const [savingColumnsConfig, setSavingColumnsConfig] = useState(false);
    const [addColOpen, setAddColOpen] = useState(false);
    const [addDocsOpen, setAddDocsOpen] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [availableProjects, setAvailableProjects] = useState<Project[]>([]);
    const [peopleModalOpen, setPeopleModalOpen] = useState(false);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [applyingWorkflow, setApplyingWorkflow] = useState(false);
    const [deleteReviewConfirmOpen, setDeleteReviewConfirmOpen] =
        useState(false);
    const [deleteReviewStatus, setDeleteReviewStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const { user } = useAuth();
    const [expandedCell, setExpandedCell] = useState<TabularCell | null>(null);
    const [expandedCellCitation, setExpandedCellCitation] = useState<
        | {
              quote: string;
              page?: number;
              sheet?: string;
              cell?: string;
              documentId?: string;
              citationRef: number;
          }
        | undefined
    >(undefined);
    const [expandedDocumentId, setExpandedDocumentId] = useState<
        string | undefined
    >(undefined);
    const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
    const [actionsOpen, setActionsOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [dragOverReviewFiles, setDragOverReviewFiles] = useState(false);
    const [uploadingDroppedFilenames, setUploadingDroppedFilenames] = useState<
        string[]
    >([]);
    const searchParams = useSearchParams();
    const initialChatParamRef = useRef<string | null>(searchParams.get("chat"));
    const [chatOpen, setChatOpen] = useState(!!initialChatParamRef.current);
    const [selectedChatId, setSelectedChatId] = useState<string | null>(
        initialChatParamRef.current && initialChatParamRef.current !== "new"
            ? initialChatParamRef.current
            : null,
    );
    const [highlightedCell, setHighlightedCell] = useState<{
        colIdx: number;
        rowIdx: number;
    } | null>(null);
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [noModelsWarning, setNoModelsWarning] =
        useState<NoModelsReason | null>(null);
    const [modelRequiredWarning, setModelRequiredWarning] = useState(false);
    const actionsRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<TRTableHandle>(null);
    const generationAbortRef = useRef<AbortController | null>(null);
    const stopRequestedRef = useRef(false);

    useEffect(
        () => () => {
            generationAbortRef.current?.abort();
        },
        [],
    );
    const router = useRouter();
    const {
        profile,
        loading: profileLoading,
        apiKeysDegraded,
    } = useUserProfile();
    // Unknown key state fails open; the submit gates below already skip when
    // apiKeys is undefined.
    const apiKeys = apiKeysDegraded ? undefined : profile?.apiKeys;
    const tabularModel = review?.model ?? "";
    const cellMutationsBlocked =
        generating || stoppingGeneration || review?.is_running === true;

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (chatOpen) {
            params.set("chat", selectedChatId ?? "new");
        } else {
            params.delete("chat");
        }
        const query = params.toString();
        const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}`;
        window.history.replaceState(null, "", newUrl);
    }, [chatOpen, selectedChatId]);

    useEffect(() => {
        if (!actionsOpen) return;
        function handleClickOutside(e: MouseEvent) {
            if (
                actionsRef.current &&
                !actionsRef.current.contains(e.target as Node)
            )
                setActionsOpen(false);
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () =>
            document.removeEventListener("mousedown", handleClickOutside);
    }, [actionsOpen]);

    useEffect(() => {
        const fetches: Promise<unknown>[] = [
            getTabularReview(reviewId).then(
                ({ review, cells, rows, documents }) => {
                    setReview(review);
                    setCells(cells);
                    setRows(rows);
                    setDocuments(documents);
                    setColumns(review.columns_config || []);
                },
            ),
        ];
        if (projectId) {
            fetches.push(
                getProject(projectId)
                    .then(setProject)
                    .catch(() => {}),
            );
        } else {
            fetches.push(
                listProjects()
                    .then(setAvailableProjects)
                    .catch(() => setAvailableProjects([])),
            );
        }
        Promise.all(fetches).finally(() => setLoading(false));
    }, [reviewId, projectId]);

    function getNextColumnIndex() {
        return (
            columns.reduce((max, column) => Math.max(max, column.index), -1) + 1
        );
    }

    async function saveColumnsConfig(nextColumns: ColumnConfig[]) {
        setSavingColumnsConfig(true);
        try {
            const updated = await updateTabularReview(reviewId, {
                columns_config: nextColumns,
            });
            setReview(updated);
            setColumns(updated.columns_config || nextColumns);
        } finally {
            setSavingColumnsConfig(false);
        }
    }

    async function handleAddDocuments(newDocs: Document[]) {
        const toAdd = newDocs.filter(
            (d) => !documents.some((existing) => existing.id === d.id),
        );
        if (!toAdd.length) return;
        const allIds = [
            ...documents.map((d) => d.id),
            ...toAdd.map((d) => d.id),
        ];

        await updateTabularReview(reviewId, {
            document_ids: allIds,
            columns_config: columns,
        });
        const detail = await getTabularReview(reviewId);
        setReview(detail.review);
        setDocuments(detail.documents);
        setRows(detail.rows);
        setCells(detail.cells);
    }

    function hasFilePayload(dt: DataTransfer): boolean {
        return Array.from(dt.types).includes("Files");
    }

    async function handleDropReviewFiles(files: File[]) {
        if (files.length === 0) return;
        setUploadingDroppedFilenames(files.map((file) => file.name));
        try {
            const uploaded: Document[] = [];
            const documentIds = documents.map((document) => document.id);
            for (const file of files) {
                const document = await uploadReviewDocument(reviewId, file, {
                    projectId,
                    documentIds,
                    columnsConfig: columns,
                });
                uploaded.push(document);
                documentIds.push(document.id);
            }
            await handleAddDocuments(uploaded);
        } catch (err) {
            console.error("Tabular review document drop upload failed", err);
        } finally {
            setUploadingDroppedFilenames([]);
        }
    }

    async function handleRegenerateCell(rowId: string, colIndex: number) {
        if (cellMutationsBlocked) {
            setGenerationGuard("running");
            return;
        }
        if (!tabularModel) {
            setModelRequiredWarning(true);
            return;
        }
        if (apiKeys && !isModelAvailable(tabularModel, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(tabularModel));
            return;
        }

        setCells((prev) =>
            prev.map((c) =>
                c.row_id === rowId && c.column_index === colIndex
                    ? { ...c, status: "generating" as const, content: null }
                    : c,
            ),
        );
        setExpandedCell((prev) =>
            prev
                ? { ...prev, status: "generating" as const, content: null }
                : null,
        );
        try {
            const result = await regenerateTabularCell(
                reviewId,
                rowId,
                colIndex,
            );
            setCells((prev) =>
                prev.map((c) =>
                    c.row_id === rowId && c.column_index === colIndex
                        ? { ...c, status: "done" as const, content: result }
                        : c,
                ),
            );
            setExpandedCell((prev) =>
                prev
                    ? { ...prev, status: "done" as const, content: result }
                    : null,
            );
        } catch (err) {
            if (
                err instanceof MikeApiError &&
                (err.code === "review_running" || err.code === "review_stale")
            ) {
                await loadLatestReview();
                return;
            }
            console.error("Regeneration failed", err);
            setCells((prev) =>
                prev.map((c) =>
                    c.row_id === rowId && c.column_index === colIndex
                        ? { ...c, status: "error" as const }
                        : c,
                ),
            );
            setExpandedCell((prev) =>
                prev ? { ...prev, status: "error" as const } : null,
            );
        }
    }

    async function refreshAfterStoppedGeneration() {
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const detail = await getTabularReview(reviewId);
            if (!detail.review.is_running) {
                setReview(detail.review);
                setCells(detail.cells);
                setRows(detail.rows);
                setDocuments(detail.documents);
                setColumns(detail.review.columns_config || []);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }

    async function handleGenerate() {
        if (!review || generating) return;

        if (review.is_running) {
            setGenerationGuard("running");
            return;
        }

        if (!tabularModel) {
            setModelRequiredWarning(true);
            return;
        }

        // If columns changed since last save, update the review first
        if (columns.length === 0) return;

        if (apiKeys && !isModelAvailable(tabularModel, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(tabularModel));
            return;
        }

        const generationAbort = new AbortController();
        generationAbortRef.current = generationAbort;
        stopRequestedRef.current = false;
        setStoppingGeneration(false);
        setGenerating(true);

        try {
            const response = await streamTabularGeneration(
                reviewId,
                review.updated_at,
                generationAbort.signal,
            );
            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                if (payload?.code === "review_running") {
                    setReview((current) =>
                        current ? { ...current, is_running: true } : current,
                    );
                    setGenerationGuard("running");
                    return;
                }
                if (payload?.code === "review_stale") {
                    setGenerationGuard("stale");
                    return;
                }
                const provider =
                    payload &&
                    ["claude", "gemini", "openai"].includes(payload.provider)
                        ? (payload.provider as ModelProvider)
                        : getModelProvider(tabularModel);
                if (payload?.code === "missing_api_key" && provider) {
                    setApiKeyModalProvider(provider);
                }
                throw new Error(
                    payload?.detail ?? `Generation failed: ${response.status}`,
                );
            }
            if (!response.body) throw new Error("No body");

            // Optimistically set empty/pending/error cells to generating (skip done cells)
            setCells((prev) =>
                rows.flatMap((row) =>
                    columns.map((col) => {
                        const existing = prev.find(
                            (c) =>
                                c.row_id === row.id &&
                                c.column_index === col.index,
                        );
                        if (existing?.status === "done" && existing?.content) {
                            return existing;
                        }
                        return existing
                            ? {
                                  ...existing,
                                  status: "generating" as const,
                                  content: null,
                              }
                            : {
                                  id: `${row.id}-${col.index}`,
                                  review_id: reviewId,
                                  row_id: row.id,
                                  document_id: row.document_id,
                                  column_index: col.index,
                                  content: null,
                                  status: "generating" as const,
                                  created_at: new Date().toISOString(),
                              };
                    }),
                ),
            );

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() ?? "";

                for (const line of lines) {
                    if (!line.startsWith("data:")) continue;
                    const dataStr = line.slice(5).trim();
                    if (dataStr === "[DONE]") break;
                    try {
                        const data = JSON.parse(dataStr);
                        if (data.type === "cell_update") {
                            setCells((prev) =>
                                prev.map((c) =>
                                    c.row_id === data.row_id &&
                                    c.column_index === data.column_index
                                        ? {
                                              ...c,
                                              content: data.content,
                                              status: data.status,
                                          }
                                        : c,
                                ),
                            );
                        }
                    } catch {}
                }
            }
        } catch (err) {
            if (!generationAbort.signal.aborted) {
                console.error("Generation failed", err);
            }
        } finally {
            if (generationAbortRef.current === generationAbort) {
                if (stopRequestedRef.current) {
                    try {
                        await refreshAfterStoppedGeneration();
                    } catch (err) {
                        console.error(
                            "Failed to refresh the stopped tabular review",
                            err,
                        );
                    }
                }
                generationAbortRef.current = null;
                stopRequestedRef.current = false;
                setGenerating(false);
                setStoppingGeneration(false);
            }
        }
    }

    async function handleReviewModelChange(model: string) {
        if (!review) return;
        if (review.is_owner === false) {
            setOwnerOnlyAction("change the tabular review model");
            return;
        }
        const updated = await updateTabularReview(reviewId, { model });
        setReview((current) =>
            current ? { ...current, model: updated.model } : current,
        );
    }

    async function loadLatestReview() {
        setReloadingLatestReview(true);
        try {
            const detail = await getTabularReview(reviewId);
            setReview(detail.review);
            setCells(detail.cells);
            setRows(detail.rows);
            setDocuments(detail.documents);
            setColumns(detail.review.columns_config || []);
            setGenerationGuard(detail.review.is_running ? "running" : null);
        } catch (err) {
            console.error("Failed to load the latest tabular review", err);
        } finally {
            setReloadingLatestReview(false);
        }
    }

    function handleStopGeneration() {
        if (!generating || stoppingGeneration) return;
        setStoppingGeneration(true);
        setCells((current) =>
            current.map((cell) =>
                cell.status === "generating"
                    ? { ...cell, status: "pending" as const }
                    : cell,
            ),
        );
        setExpandedCell((current) =>
            current?.status === "generating"
                ? { ...current, status: "pending" as const }
                : current,
        );
        stopRequestedRef.current = true;
        generationAbortRef.current?.abort();
    }

    async function handleAddColumn(newColumns: ColumnConfig[]) {
        const startIndex = getNextColumnIndex();
        const normalizedColumns = newColumns.map((column, index) => ({
            ...column,
            index: startIndex + index,
        }));
        const newCols = [...columns, ...normalizedColumns];
        setSavingColumn(true);
        setColumns(newCols);
        setCells((prev) => [
            ...prev,
            ...rows
                .filter((row) =>
                    normalizedColumns.some(
                        (column) =>
                            !prev.some(
                                (cell) =>
                                    cell.row_id === row.id &&
                                    cell.column_index === column.index,
                            ),
                    ),
                )
                .flatMap((row) =>
                    normalizedColumns
                        .filter(
                            (column) =>
                                !prev.some(
                                    (cell) =>
                                        cell.row_id === row.id &&
                                        cell.column_index === column.index,
                                ),
                        )
                        .map((column) => ({
                            id: `new-${row.id}-${column.index}`,
                            review_id: reviewId,
                            row_id: row.id,
                            document_id: row.document_id,
                            column_index: column.index,
                            content: null,
                            status: "pending" as const,
                            created_at: new Date().toISOString(),
                        })),
                ),
        ]);
        try {
            await saveColumnsConfig(newCols);
        } catch (err) {
            setColumns(columns);
            setCells((prev) =>
                prev.filter(
                    (cell) =>
                        !normalizedColumns.some(
                            (column) => column.index === cell.column_index,
                        ),
                ),
            );
            console.error("Failed to save column", err);
        } finally {
            setSavingColumn(false);
        }
    }

    async function handleUpdateColumn(nextColumn: ColumnConfig) {
        const nextColumns = columns.map((column) =>
            column.index === nextColumn.index ? nextColumn : column,
        );
        const previousColumns = columns;
        setColumns(nextColumns);
        try {
            await saveColumnsConfig(nextColumns);
        } catch (err) {
            setColumns(previousColumns);
            console.error("Failed to update column", err);
        }
    }

    async function handleDeleteColumn(columnIndex: number) {
        const previousColumns = columns;
        const nextColumns = columns.filter(
            (column) => column.index !== columnIndex,
        );
        setColumns(nextColumns);
        try {
            await saveColumnsConfig(nextColumns);
        } catch (err) {
            setColumns(previousColumns);
            console.error("Failed to delete column", err);
        }
    }

    function handleTabularCitationClick(colIdx: number, rowIdx: number) {
        setSearch("");
        setHighlightedCell({ colIdx, rowIdx });
        setTimeout(() => {
            tableRef.current?.scrollToCell(colIdx, rowIdx);
        }, 50);
        setTimeout(() => setHighlightedCell(null), 3000);
    }

    function handleDocumentOpen(row: TabularReviewRow, document: Document) {
        const firstColumn = [...columns].sort(
            (left, right) => left.index - right.index,
        )[0];
        if (!firstColumn) return;
        const firstCell = cells.find(
            (cell) =>
                cell.row_id === row.id &&
                cell.column_index === firstColumn.index,
        );
        if (!firstCell) return;

        setExpandedCell(firstCell);
        setExpandedCellCitation(undefined);
        setExpandedDocumentId(document.id);
    }

    async function handleDeleteDocuments() {
        const rowIdsToDelete = [...selectedRowIds];
        if (rowIdsToDelete.length === 0) return;
        const documentIdsToDelete = new Set(
            rows
                .filter((row) => rowIdsToDelete.includes(row.id))
                .flatMap((row) => row.source_document_ids),
        );
        const previousDocuments = documents;
        const previousRows = rows;
        const previousCells = cells;
        const remaining = documents.filter(
            (document) => !documentIdsToDelete.has(document.id),
        );
        setDocuments(remaining);
        setRows((current) =>
            current.filter((row) => !rowIdsToDelete.includes(row.id)),
        );
        setCells((current) =>
            current.filter((cell) => !rowIdsToDelete.includes(cell.row_id)),
        );
        setSelectedRowIds([]);
        setActionsOpen(false);
        try {
            await updateTabularReview(reviewId, {
                document_ids: remaining.map((d) => d.id),
                columns_config: columns,
            });
            const detail = await getTabularReview(reviewId);
            setReview(detail.review);
            setDocuments(detail.documents);
            setRows(detail.rows);
            setCells(detail.cells);
        } catch (err) {
            setDocuments(previousDocuments);
            setRows(previousRows);
            setCells(previousCells);
            setSelectedRowIds(rowIdsToDelete);
            console.error("Failed to delete tabular review documents", err);
        }
    }

    async function clearResultsForRows(rowIds: string[]) {
        if (rowIds.length === 0) return;
        if (cellMutationsBlocked) {
            setGenerationGuard("running");
            return;
        }
        const previousCells = cells;
        const previousSelectedRowIds = selectedRowIds;
        setCells((prev) =>
            prev.map((c) =>
                rowIds.includes(c.row_id)
                    ? { ...c, content: null, status: "pending" }
                    : c,
            ),
        );
        setSelectedRowIds([]);
        setActionsOpen(false);
        try {
            await clearTabularCells(reviewId, rowIds);
        } catch (err) {
            if (
                err instanceof MikeApiError &&
                (err.code === "review_running" || err.code === "review_stale")
            ) {
                await loadLatestReview();
                return;
            }
            setCells(previousCells);
            setSelectedRowIds(previousSelectedRowIds);
            console.error("Failed to clear tabular review results", err);
        }
    }

    async function handleClearResults() {
        await clearResultsForRows([...selectedRowIds]);
    }

    async function handleClearAllResults() {
        await clearResultsForRows(rows.map((row) => row.id));
    }

    function requestReviewDetails() {
        if (review?.is_owner === false) {
            setOwnerOnlyAction("edit tabular review details");
            return;
        }
        setDetailsOpen(true);
    }

    async function handleDetailsSave(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (!review || review.is_owner === false) {
            setOwnerOnlyAction("edit tabular review details");
            return;
        }
        const updated = await updateTabularReview(reviewId, {
            title: values.title,
            project_id: values.projectId ?? null,
        });
        setReview((prev) =>
            prev
                ? {
                      ...prev,
                      ...updated,
                  }
                : updated,
        );
        if (!projectId && updated.project_id) {
            setDetailsOpen(false);
            router.push(
                `/projects/${updated.project_id}/tabular-reviews/${reviewId}`,
            );
        }
    }

    function requestReviewDelete() {
        if (review?.is_owner === false) {
            setOwnerOnlyAction("delete this tabular review");
            return;
        }
        setDeleteReviewStatus("idle");
        setDeleteReviewConfirmOpen(true);
    }

    async function confirmReviewDelete() {
        if (deleteReviewStatus === "deleting") return;
        setDeleteReviewStatus("deleting");
        try {
            await deleteTabularReview(reviewId);
            setDeleteReviewStatus("deleted");
            setTimeout(() => {
                router.push(
                    projectId
                        ? `/projects/${projectId}/tabular-reviews`
                        : "/tabular-reviews",
                );
            }, 250);
        } catch (err) {
            setDeleteReviewStatus("idle");
            console.error("Failed to delete tabular review", err);
        }
    }

    function requestWorkflow() {
        if (review?.is_owner === false) {
            setOwnerOnlyAction("apply a workflow");
            return;
        }
        setWorkflowModalOpen(true);
    }

    async function handleApplyWorkflow(workflow: Workflow) {
        if (!workflow.columns_config?.length) return;
        const nextColumns = workflow.columns_config.map((column, index) => ({
            ...column,
            index,
        }));
        const previousColumns = columns;
        const previousCells = cells;
        setApplyingWorkflow(true);
        setColumns(nextColumns);
        setCells([]);
        try {
            await saveColumnsConfig(nextColumns);
            if (rows.length > 0) {
                try {
                    await clearTabularCells(
                        reviewId,
                        rows.map((row) => row.id),
                    );
                } catch (err) {
                    console.error("Failed to clear old tabular cells", err);
                }
            }
            const detail = await getTabularReview(reviewId);
            setReview(detail.review);
            setRows(detail.rows);
            setCells(detail.cells);
            setWorkflowModalOpen(false);
        } catch (err) {
            setColumns(previousColumns);
            setCells(previousCells);
            console.error("Failed to apply workflow", err);
        } finally {
            setApplyingWorkflow(false);
        }
    }

    const q = search.toLowerCase();
    const filteredRows = q
        ? rows.filter((row) => row.label.toLowerCase().includes(q))
        : rows;

    return (
        <div className="flex h-full overflow-hidden">
            <div className="flex flex-1 flex-col overflow-hidden">
                {/* Header */}
                <PageHeader
                    shrink
                    breadcrumbs={[
                        ...(projectId
                            ? [
                                  {
                                      label: "Projects",
                                      onClick: () => router.push("/projects"),
                                  },
                                  loading
                                      ? {
                                            loading: true,
                                            skeletonClassName: "w-32",
                                            onClick: () =>
                                                router.push(
                                                    `/projects/${projectId}`,
                                                ),
                                            title: "Back to project",
                                        }
                                      : {
                                            label: project?.name ?? "",
                                            onClick: () =>
                                                router.push(
                                                    `/projects/${projectId}`,
                                                ),
                                            title: "Back to project",
                                        },
                              ]
                            : [
                                  {
                                      label: "Tabular Reviews",
                                      onClick: () =>
                                          router.push("/tabular-reviews"),
                                      title: "Back to Tabular Reviews",
                                  },
                              ]),
                        ...(projectId
                            ? [
                                  {
                                      label: "Tabular Reviews",
                                      onClick: () =>
                                          router.push(
                                              `/projects/${projectId}/tabular-reviews`,
                                          ),
                                      title: "Back to Tabular Reviews",
                                  },
                              ]
                            : []),
                        loading
                            ? {
                                  loading: true,
                                  skeletonClassName: "w-40",
                              }
                            : {
                                  label: review?.title || "Untitled Review",
                              },
                    ]}
                    actionGroups={[
                        [
                            {
                                type: "search",
                                value: search,
                                onChange: setSearch,
                                placeholder: "Search rows…",
                            },
                            !projectId
                                ? {
                                      onClick: () => setPeopleModalOpen(true),
                                      disabled: loading,
                                      iconOnly: true,
                                      title: "People with access",
                                      icon: <Users className="h-4 w-4" />,
                                  }
                                : null,
                            {
                                type: "custom",
                                render: (
                                    <HeaderActionsMenu
                                        items={[
                                            {
                                                label: "Edit details",
                                                icon: Pencil,
                                                onSelect: requestReviewDetails,
                                            },
                                            {
                                                label: "Apply workflow",
                                                icon: WandSparkles,
                                                onSelect: requestWorkflow,
                                            },
                                            {
                                                label: "Export",
                                                icon: Download,
                                                onSelect: () =>
                                                    exportTabularReviewToExcel({
                                                        reviewTitle:
                                                            review?.title ||
                                                            "Tabular Review",
                                                        columns,
                                                        rows,
                                                        cells,
                                                    }),
                                                disabled:
                                                    columns.length === 0 ||
                                                    rows.length === 0,
                                            },
                                            {
                                                label: "Clear results",
                                                icon: X,
                                                onSelect: handleClearAllResults,
                                                disabled:
                                                    rows.length === 0 ||
                                                    cellMutationsBlocked,
                                            },
                                            {
                                                label: "Delete",
                                                icon: Trash2,
                                                onSelect: requestReviewDelete,
                                                variant: "danger",
                                            },
                                        ]}
                                    />
                                ),
                            },
                        ],
                        {
                            actions: [
                                {
                                    type: "custom",
                                    render: (
                                        <ModelToggle
                                            value={tabularModel}
                                            onChange={(model) =>
                                                void handleReviewModelChange(
                                                    model,
                                                )
                                            }
                                            apiKeys={apiKeys}
                                            apiKeysLoading={
                                                profileLoading && !profile
                                            }
                                            openRouterModels={
                                                profile?.openRouterModels
                                            }
                                            vercelModels={profile?.vercelModels}
                                            openCodeGoModels={
                                                profile?.openCodeGoModels
                                            }
                                            onNoModelsClick={setNoModelsWarning}
                                        />
                                    ),
                                },
                                {
                                    onClick: () => setAddDocsOpen(true),
                                    disabled: loading || savingColumnsConfig,
                                    title: "Add documents",
                                    icon: <Upload className="h-4 w-4" />,
                                    iconOnly: true,
                                },
                            ],
                        },
                        {
                            actions: [
                                {
                                    onClick: generating
                                        ? handleStopGeneration
                                        : handleGenerate,
                                    disabled:
                                        stoppingGeneration ||
                                        columns.length === 0 ||
                                        rows.length === 0 ||
                                        savingColumnsConfig,
                                    title: stoppingGeneration
                                        ? "Stopping generation"
                                        : generating
                                          ? "Stop generation"
                                          : "Run review",
                                    icon: stoppingGeneration ? (
                                        <Loader2 className="h-4 w-4 animate-spin" />
                                    ) : generating ? (
                                        <Square className="h-3.5 w-3.5" />
                                    ) : (
                                        <Play className="h-4 w-4" />
                                    ),
                                    label: (
                                        <span className="hidden sm:inline">
                                            {stoppingGeneration
                                                ? "Stopping…"
                                                : generating
                                                  ? "Stop"
                                                  : "Run"}
                                        </span>
                                    ),
                                },
                            ],
                        },
                        {
                            actions: [
                                {
                                    onClick: () => {
                                        if (!chatOpen) setSidebarOpen(false);
                                        if (chatOpen) setSelectedChatId(null);
                                        setChatOpen((v) => !v);
                                    },
                                    disabled:
                                        loading ||
                                        columns.length === 0 ||
                                        rows.length === 0,
                                    title: chatOpen
                                        ? "Close chat"
                                        : "Open chat",
                                    icon: chatOpen ? (
                                        <MessageSquareX className="h-4 w-4" />
                                    ) : (
                                        <MessageSquare className="h-4 w-4" />
                                    ),
                                    label: (
                                        <span className="hidden sm:inline">
                                            Chat
                                        </span>
                                    ),
                                },
                            ],
                        },
                    ]}
                />

                {/* Toolbar + table column, chat panel beside it */}
                <div className="flex flex-1 overflow-hidden">
                    {/* On mobile the chat panel replaces the table entirely */}
                    <div
                        className={`flex flex-1 flex-col overflow-hidden ${
                            chatOpen ? "max-md:hidden" : ""
                        }`}
                    >
                        <TableToolbar
                            items={[]}
                            active="table"
                            onChange={() => undefined}
                            actions={
                                <div className="flex items-center gap-1.5">
                                    {loading ? (
                                        <div className="h-3 w-24 rounded bg-gray-100 animate-pulse" />
                                    ) : null}
                                    {!loading && selectedRowIds.length > 0 && (
                                        <>
                                            {/* Desktop: compact Actions menu */}
                                            <div
                                                ref={actionsRef}
                                                className="relative max-md:hidden"
                                            >
                                                <TabPillButton
                                                    onClick={() =>
                                                        setActionsOpen(
                                                            (v) => !v,
                                                        )
                                                    }
                                                >
                                                    Actions
                                                    <ChevronDown className="h-3.5 w-3.5" />
                                                </TabPillButton>
                                                {actionsOpen && (
                                                    <div
                                                        className={`absolute right-0 top-full z-50 mt-1 w-36 overflow-hidden rounded-lg ${LIQUID_GLASS_FLOAT_CLASS} backdrop-blur-2xl`}
                                                    >
                                                        <button
                                                            onClick={
                                                                handleClearResults
                                                            }
                                                            disabled={
                                                                cellMutationsBlocked
                                                            }
                                                            className="theme-dropdown-item w-full px-3 py-1.5 text-left text-xs text-gray-700 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                                                        >
                                                            Clear results
                                                        </button>
                                                        <button
                                                            onClick={
                                                                handleDeleteDocuments
                                                            }
                                                            className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                                                        >
                                                            Delete
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                            {/* Mobile (toolbar dropdown): flattened entries */}
                                            <TabPillButton
                                                onClick={handleClearResults}
                                                disabled={cellMutationsBlocked}
                                                className="md:hidden"
                                            >
                                                Clear results
                                            </TabPillButton>
                                            <TabPillButton
                                                onClick={handleDeleteDocuments}
                                                className="md:hidden text-red-600"
                                            >
                                                Delete
                                            </TabPillButton>
                                        </>
                                    )}
                                    {!loading && (
                                        <TabPillButton
                                            onClick={() => setAddColOpen(true)}
                                            disabled={
                                                savingColumn ||
                                                savingColumnsConfig
                                            }
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                            Add Columns
                                        </TabPillButton>
                                    )}
                                </div>
                            }
                        />
                        <div
                            className="relative flex flex-1 overflow-hidden"
                            onDragOver={(e) => {
                                if (!hasFilePayload(e.dataTransfer)) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "copy";
                                setDragOverReviewFiles(true);
                            }}
                            onDragLeave={(e) => {
                                if (
                                    !e.currentTarget.contains(
                                        e.relatedTarget as Node,
                                    )
                                ) {
                                    setDragOverReviewFiles(false);
                                }
                            }}
                            onDrop={(e) => {
                                if (!hasFilePayload(e.dataTransfer)) return;
                                e.preventDefault();
                                e.stopPropagation();
                                setDragOverReviewFiles(false);
                                void handleDropReviewFiles(
                                    Array.from(e.dataTransfer.files),
                                );
                            }}
                        >
                            <TRTable
                                ref={tableRef}
                                loading={loading}
                                documentGrouping={
                                    review?.document_grouping ?? "document"
                                }
                                columns={columns}
                                rows={filteredRows}
                                documents={documents}
                                cells={cells}
                                highlightedCell={highlightedCell}
                                savingColumn={savingColumn}
                                savingColumnsConfig={savingColumnsConfig}
                                selectedRowIds={selectedRowIds}
                                uploadingFilenames={uploadingDroppedFilenames}
                                dragOverFiles={dragOverReviewFiles}
                                onSelectionChange={setSelectedRowIds}
                                onDocumentOpen={handleDocumentOpen}
                                onExpand={(cell) => {
                                    setExpandedCell(cell);
                                    setExpandedCellCitation(undefined);
                                    setExpandedDocumentId(undefined);
                                }}
                                onCitationClick={(
                                    cell,
                                    page,
                                    quote,
                                    citationRef,
                                    sheet,
                                    citationCell,
                                    documentId,
                                ) => {
                                    setExpandedCell(cell);
                                    setExpandedCellCitation({
                                        quote,
                                        page,
                                        sheet,
                                        cell: citationCell,
                                        documentId,
                                        citationRef,
                                    });
                                    setExpandedDocumentId(undefined);
                                }}
                                onUpdateColumn={handleUpdateColumn}
                                onDeleteColumn={handleDeleteColumn}
                                onAddColumn={() => setAddColOpen(true)}
                                onAddDocuments={() => setAddDocsOpen(true)}
                            />
                        </div>
                    </div>
                    {chatOpen && (
                        <TRChatPanel
                            reviewId={reviewId}
                            reviewTitle={review?.title ?? null}
                            projectName={project?.name ?? null}
                            onCitationClick={handleTabularCitationClick}
                            onClose={() => {
                                setSelectedChatId(null);
                                setChatOpen(false);
                            }}
                            initialChatId={selectedChatId}
                            onChatIdChange={setSelectedChatId}
                        />
                    )}
                </div>
            </div>

            {/* Cell detail side panel */}
            {expandedCell &&
                (() => {
                    const expandedRow = rows.find(
                        (row) => row.id === expandedCell.row_id,
                    );
                    const citedDocumentId =
                        expandedCellCitation?.documentId &&
                        expandedRow?.source_document_ids.includes(
                            expandedCellCitation.documentId,
                        )
                            ? expandedCellCitation.documentId
                            : undefined;
                    const requestedDocumentId =
                        citedDocumentId ??
                        expandedDocumentId ??
                        expandedRow?.document_id;
                    const expandedDoc = documents.find(
                        (document) => document.id === requestedDocumentId,
                    );
                    const expandedCol = columns.find(
                        (c) => c.index === expandedCell.column_index,
                    );
                    if (!expandedRow || !expandedCol) return null;
                    return (
                        <TRSidePanel
                            cell={expandedCell}
                            row={expandedRow}
                            rows={filteredRows}
                            document={expandedDoc}
                            documents={documents}
                            column={expandedCol}
                            columns={columns}
                            onClose={() => {
                                setExpandedCell(null);
                                setExpandedCellCitation(undefined);
                                setExpandedDocumentId(undefined);
                            }}
                            onNavigate={(rowId, columnIndex) => {
                                const nextCell = cells.find(
                                    (candidate) =>
                                        candidate.row_id === rowId &&
                                        candidate.column_index === columnIndex,
                                );
                                if (nextCell) {
                                    setExpandedCell(nextCell);
                                    setExpandedCellCitation(undefined);
                                    setExpandedDocumentId(undefined);
                                }
                            }}
                            onRegenerate={
                                cellMutationsBlocked
                                    ? undefined
                                    : () =>
                                          handleRegenerateCell(
                                              expandedRow.id,
                                              expandedCell.column_index,
                                          )
                            }
                            displayDocument={
                                !!expandedDoc &&
                                (expandedCellCitation !== undefined ||
                                    expandedDocumentId !== undefined)
                            }
                            documentOnly={expandedDocumentId !== undefined}
                            citationQuote={expandedCellCitation?.quote}
                            citationPage={expandedCellCitation?.page}
                            citationSheet={expandedCellCitation?.sheet}
                            citationCell={expandedCellCitation?.cell}
                            citationDocumentId={
                                expandedCellCitation?.documentId
                            }
                            citationRef={expandedCellCitation?.citationRef}
                        />
                    );
                })()}

            <AddColumnModal
                open={addColOpen}
                existingCount={columns.length}
                onClose={() => setAddColOpen(false)}
                onAdd={handleAddColumn}
            />

            {project ? (
                <AddDocumentsModal
                    open={addDocsOpen}
                    onClose={() => setAddDocsOpen(false)}
                    onSelect={(docs: Document[]) => handleAddDocuments(docs)}
                    breadcrumb={[
                        "Projects",
                        project.name +
                            (project.cm_number
                                ? ` (#${project.cm_number})`
                                : ""),
                        "Tabular Reviews",
                        ...(review ? [review.title || "Untitled Review"] : []),
                        "Add Documents",
                    ]}
                    uploadStateId={`tabular-review:${review?.id ?? "new"}:project`}
                    projectId={project.id}
                    projectDocumentsOnly
                    disabledDocumentIds={
                        new Set(documents.map((document) => document.id))
                    }
                />
            ) : (
                <AddDocumentsModal
                    open={addDocsOpen}
                    onClose={() => setAddDocsOpen(false)}
                    onSelect={(docs: Document[]) => handleAddDocuments(docs)}
                    breadcrumb={[
                        "Tabular Reviews",
                        ...(review ? [review.title || "Untitled Review"] : []),
                        "Add Documents",
                    ]}
                    uploadStateId={`tabular-review:${review?.id ?? "new"}:library`}
                    tabs={["files", "projects"]}
                />
            )}

            <TabularReviewDetailsModal
                open={detailsOpen}
                review={review}
                projects={project ? [project] : availableProjects}
                canEdit={review?.is_owner !== false}
                lockProject={Boolean(projectId)}
                onClose={() => setDetailsOpen(false)}
                onSave={handleDetailsSave}
            />

            <PeopleModal
                open={peopleModalOpen}
                onClose={() => setPeopleModalOpen(false)}
                resource={review}
                fetchPeople={getTabularReviewPeople}
                currentUserEmail={user?.email ?? null}
                breadcrumb={[
                    "Tabular Reviews",
                    review?.title || "Untitled Review",
                    "People",
                ]}
                // Only the review owner may modify the member list. PeopleModal
                // hides the add/remove controls when this prop is undefined.
                onSharedWithChange={
                    review?.is_owner === false
                        ? undefined
                        : async (next) => {
                              const updated = await updateTabularReview(
                                  reviewId,
                                  {
                                      shared_with: next,
                                  },
                              );
                              setReview((prev) =>
                                  prev
                                      ? {
                                            ...prev,
                                            ...updated,
                                            is_owner: prev.is_owner,
                                        }
                                      : updated,
                              );
                          }
                }
            />

            <TRWorkflowModal
                open={workflowModalOpen}
                onClose={() => {
                    if (applyingWorkflow) return;
                    setWorkflowModalOpen(false);
                }}
                onApply={handleApplyWorkflow}
                breadcrumbs={[
                    ...(project
                        ? [
                              "Projects",
                              project.name +
                                  (project.cm_number
                                      ? ` (#${project.cm_number})`
                                      : ""),
                          ]
                        : []),
                    "Tabular Reviews",
                    review?.title || "Untitled Review",
                    "Add workflow",
                ]}
                applying={applyingWorkflow}
            />

            <ConfirmPopup
                open={deleteReviewConfirmOpen}
                title="Delete tabular review?"
                message="This will permanently delete the tabular review and its generated cells."
                confirmLabel="Delete"
                confirmStatus={
                    deleteReviewStatus === "deleting"
                        ? "loading"
                        : deleteReviewStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (deleteReviewStatus === "deleting") return;
                    setDeleteReviewConfirmOpen(false);
                    setDeleteReviewStatus("idle");
                }}
                onConfirm={() => void confirmReviewDelete()}
            />

            <OwnerOnlyPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />

            <ApiKeyMissingPopup
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />

            <NoModelsWarningPopup
                reason={noModelsWarning}
                onClose={() => setNoModelsWarning(null)}
            />

            <WarningPopup
                open={modelRequiredWarning}
                title="Select a model"
                message="Select a model for this tabular review before running it."
                onClose={() => setModelRequiredWarning(false)}
            />

            <WarningPopup
                open={generationGuard === "running"}
                title="Tabular review is already running"
                message="This review is being run in another tab or by another collaborator. Wait for that run to finish or be stopped before trying again."
                onClose={() => {
                    if (!reloadingLatestReview) setGenerationGuard(null);
                }}
                primaryAction={{
                    label: reloadingLatestReview ? "Checking…" : "Check again",
                    disabled: reloadingLatestReview,
                    onClick: () => void loadLatestReview(),
                }}
            />

            <WarningPopup
                open={generationGuard === "stale"}
                title="A newer version is available"
                message="Load the latest version of this tabular review before running it."
                onClose={() => {
                    if (!reloadingLatestReview) setGenerationGuard(null);
                }}
                primaryAction={{
                    label: reloadingLatestReview ? "Loading…" : "Load latest",
                    disabled: reloadingLatestReview,
                    onClick: () => void loadLatestReview(),
                }}
            />
        </div>
    );
}
