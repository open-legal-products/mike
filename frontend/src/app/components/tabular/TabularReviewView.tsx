"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
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
    X,
    Pencil,
    Trash2,
    WandSparkles,
} from "lucide-react";

import {
    clearTabularCells,
    deleteTabularReview,
    getTabularReviewAccess,
    getTabularReview,
    getProject,
    getTabularReviewPeople,
    listProjects,
    grantTabularReviewAccess,
    regenerateTabularCell,
    streamTabularGeneration,
    streamTabularGenerationResume,
    updateTabularReview,
    revokeTabularReviewAccess,
    uploadReviewDocument,
    MikeApiError,
    type ContentAccessGrant,
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
import { AccessModal } from "../modals/AccessModal";
import { PermissionDeniedPopup } from "../popups/PermissionDeniedPopup";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { ConfirmPopup } from "../popups/ConfirmPopup";
import { WarningPopup } from "../popups/WarningPopup";
import { NoModelsWarningPopup } from "../popups/NoModelsWarningPopup";
import { HeaderActionsMenu } from "../shared/HeaderActionsMenu";
import { DocumentUploadMenu } from "../shared/DocumentUploadMenu";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    can,
    roleFromLoaded,
    type ProjectRole,
} from "@/app/lib/permissions";
import {
    permissionDeniedProps,
    type OwnerGate,
} from "@/app/components/projects/ProjectWorkspace";
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
import { SUPPORTED_DOCUMENT_ACCEPT } from "@/app/lib/documentUploadValidation";

interface Props {
    reviewId: string;
    projectId?: string;
}

export function TRView({ reviewId, projectId }: Props) {
    const t = useTranslations("tabular");
    const tPermissao = useTranslations("popups.permissao");
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
    const [accessModalOpen, setAccessModalOpen] = useState(false);
    const [grants, setGrants] = useState<ContentAccessGrant[] | null>(null);
    const [workflowModalOpen, setWorkflowModalOpen] = useState(false);
    const [applyingWorkflow, setApplyingWorkflow] = useState(false);
    const [deleteReviewConfirmOpen, setDeleteReviewConfirmOpen] =
        useState(false);
    const [deleteReviewStatus, setDeleteReviewStatus] = useState<
        "idle" | "deleting" | "deleted"
    >("idle");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<OwnerGate | null>(
        null,
    );
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
    const [dropUploadWarning, setDropUploadWarning] = useState<string | null>(
        null,
    );
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
    const reviewFileUploadInputRef = useRef<HTMLInputElement>(null);
    const reviewFolderUploadInputRef = useRef<HTMLInputElement>(null);
    const generationAbortRef = useRef<AbortController | null>(null);
    const stopRequestedRef = useRef(false);
    // Only one resume stream may be open at a time — mount, a 202 regenerate
    // and a dropped generate stream can all ask for one.
    const resumeStreamOpenRef = useRef(false);

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
        // Cancellation flag: on a rapid reviewId change the previous fetch
        // can resolve AFTER the new one and clobber fresh state with stale
        // data; drop its results instead.
        let cancelled = false;
        const fetches: Promise<unknown>[] = [
            getTabularReview(reviewId).then(
                ({ review, cells, rows, documents }) => {
                    if (cancelled) return;
                    setReview(review);
                    setCells(cells);
                    setRows(rows);
                    setDocuments(documents);
                    setColumns(review.columns_config || []);
                    // A run may still be executing server-side (e.g. after a
                    // refresh, or in another tab) — reattach to it through the
                    // resumable stream instead of showing a spinner nothing will
                    // ever resolve. `is_running` is the review's live generation
                    // lease; cells left "generating" cover a run whose lease has
                    // lapsed but whose terminal states are still landing.
                    if (
                        review.is_running ||
                        cells.some((c) => c.status === "generating")
                    ) {
                        resumeGenerationStream().catch((err) =>
                            console.error("Generation resume failed", err),
                        );
                    }
                },
            ),
        ];
        if (projectId) {
            fetches.push(
                getProject(projectId)
                    .then((loaded) => {
                        if (!cancelled) setProject(loaded);
                    })
                    .catch(() => {}),
            );
        } else {
            fetches.push(
                listProjects()
                    .then((loaded) => {
                        if (!cancelled) setAvailableProjects(loaded);
                    })
                    .catch(() => {
                        if (!cancelled) setAvailableProjects([]);
                    }),
            );
        }
        Promise.all(fetches).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [reviewId, projectId]);

    function getNextColumnIndex() {
        return (
            columns.reduce((max, column) => Math.max(max, column.index), -1) + 1
        );
    }

    // Role ladder for this review, or null while the review is still loading.
    // It used to read "admin" until the row arrived, which opened every gate
    // during the one window where nothing is known — a viewer landing on the
    // page could open the delete confirmation before the payload came back.
    // Unknown is now its own state: no capability is granted, and no refusal
    // is shown either, because the affordances are disabled instead.
    //
    // Reshaping the review (columns, document set, clearing cells) and running
    // it are member-tier server-side — a member is the normal collaborator,
    // and splitting "edit content" from "edit structure" only ever produced
    // two refusals for one job. Deleting the review stays admin.
    const reviewRole: ProjectRole | null = roleFromLoaded(review);
    const roleKnown = reviewRole !== null;
    const canEditContent = can(reviewRole, "content.edit");

    const refreshGrants = useCallback(async () => {
        try {
            const access = await getTabularReviewAccess(reviewId);
            setGrants(access.grants);
        } catch (error) {
            console.error("[tabular review] failed to load access", error);
            setGrants([]);
        }
    }, [reviewId]);

    useEffect(() => {
        setGrants(null);
    }, [reviewId]);

    useEffect(() => {
        if (
            accessModalOpen &&
            grants === null &&
            can(reviewRole, "access.manage")
        )
            void refreshGrants();
    }, [accessModalOpen, grants, reviewRole, refreshGrants]);

    function requireContent(action: string): boolean {
        if (canEditContent) return true;
        // Silent while the role is unknown: the control is disabled, so a
        // stray call is a no-op rather than an accusation.
        if (roleKnown) setOwnerOnlyAction({ action, requiredRole: "editor" });
        return false;
    }

    const requireStructure = requireContent;

    // Who to ask when an action is refused. A review inside a project inherits
    // that project's admin contacts; a standalone review's contact is its
    // creator, which only the people roster knows — so it is fetched the first
    // time a refusal actually happens rather than on every page load.
    const [reviewContacts, setReviewContacts] = useState<
        { email: string | null; display_name: string | null }[] | null
    >(null);
    const deniedContacts = project?.admin_contacts ?? reviewContacts;
    useEffect(() => {
        if (!ownerOnlyAction || project || reviewContacts) return;
        let cancelled = false;
        getTabularReviewPeople(reviewId)
            .then((people) => {
                if (cancelled) return;
                setReviewContacts(people.owner ? [people.owner] : []);
            })
            .catch(() => {
                if (!cancelled) setReviewContacts([]);
            });
        return () => {
            cancelled = true;
        };
    }, [ownerOnlyAction, project, reviewContacts, reviewId]);

    async function saveColumnsConfig(nextColumns: ColumnConfig[]) {
        setSavingColumnsConfig(true);
        try {
            const updated = await updateTabularReview(reviewId, {
                columns_config: nextColumns,
            });
            // The PATCH response is the bare DB row — no access_role /
            // is_owner — so replacing the review state with it would send
            // roleFrom to its fail-closed fallback and shut every client gate
            // for an admin. Merge so the detail fields survive.
            setReview((prev) => (prev ? { ...prev, ...updated } : updated));
            setColumns(updated.columns_config || nextColumns);
        } finally {
            setSavingColumnsConfig(false);
        }
    }

    async function handleAddDocuments(newDocs: Document[]) {
        // Changing the review's document set is a structure edit server-side
        // (PATCH document_ids 403s below member) — same gate as columns.
        if (!requireStructure(tPermissao("acaoEditarConjuntoDocumentos"))) return;
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
        // The drop path uploads first and attaches after; without this gate
        // a viewer's upload succeeds and the attach PATCH 403s, leaving an
        // orphaned document. Mirror the DocTable drop gate, at the tier the
        // attach actually requires.
        if (!requireStructure(tPermissao("acaoAdicionarDocumentosRevisao")))
            return;
        setUploadingDroppedFilenames(files.map((file) => file.name));
        const uploaded: Document[] = [];
        let failedNames: string[] = [];
        try {
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
        } catch (err) {
            console.error("Tabular review document drop upload failed", err);
            failedNames = files.slice(uploaded.length).map((f) => f.name);
        }
        try {
            // Each successful upload already attached itself server-side, so
            // refresh even after a mid-loop failure — otherwise the attached
            // files stay invisible until a manual reload.
            if (uploaded.length > 0) await handleAddDocuments(uploaded);
        } catch (err) {
            console.error("Refreshing review documents failed", err);
        } finally {
            setUploadingDroppedFilenames([]);
        }
        if (failedNames.length > 0) {
            setDropUploadWarning(
                failedNames.length === 1
                    ? t("revisaoView.falhaUploadUnico", {
                          name: failedNames[0],
                      })
                    : t("revisaoView.falhaUploadVarios", {
                          count: failedNames.length,
                      }),
            );
        }
    }

    async function handleRegenerateCell(rowId: string, colIndex: number) {
        if (!requireContent(tPermissao("acaoRegenerarCelulas"))) return;
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
            if ("status" in result) {
                // HTTP 202 — the work continues in the background. Leave the
                // cell "generating" and pick up the terminal state from the
                // resumable stream.
                resumeGenerationStream().catch((err) =>
                    console.error("Generation resume failed", err),
                );
                return;
            }
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

    // Reads an SSE response and applies cell_update frames until [DONE].
    // Shared by the POST /generate stream and the GET resume stream, which
    // emit the identical frame shape.
    async function consumeGenerationStream(response: Response) {
        if (!response.body) throw new Error("No body");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;

        while (!finished) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.startsWith("data:")) continue;
                const dataStr = line.slice(5).trim();
                if (dataStr === "[DONE]") {
                    finished = true;
                    break;
                }
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
    }

    // Reattach to a run still executing server-side through the reconnectable
    // GET view. It takes no generation lease, so it can never 409 a run or
    // restart one; it only tails what the workers are already doing.
    //
    // Abort ownership follows the same `generationAbortRef` pattern as
    // `handleGenerate`: when a generate run is in flight we borrow ITS
    // controller, so the stop button and unmount abort the reconnect too.
    // Otherwise (mount on a running review, or a 202 regenerate) the resume
    // owns a controller for its own lifetime and clears it on the way out —
    // it never overwrites a live run's controller, which `handleGenerate`'s
    // `finally` identity-checks.
    async function resumeGenerationStream() {
        if (resumeStreamOpenRef.current) return;
        resumeStreamOpenRef.current = true;
        const ownedAbort = generationAbortRef.current
            ? null
            : new AbortController();
        if (ownedAbort) generationAbortRef.current = ownedAbort;
        const abort = generationAbortRef.current;
        try {
            const response = await streamTabularGenerationResume(
                reviewId,
                abort?.signal,
            );
            if (!response.ok) {
                throw new Error(`Resume failed: ${response.status}`);
            }
            await consumeGenerationStream(response);
        } catch (err) {
            if (!ownedAbort?.signal.aborted) throw err;
        } finally {
            resumeStreamOpenRef.current = false;
            if (ownedAbort && generationAbortRef.current === ownedAbort)
                generationAbortRef.current = null;
        }
    }

    async function handleGenerate() {
        if (!review || generating) return;
        if (!requireContent(tPermissao("acaoExecutarGeracao"))) return;

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

            try {
                await consumeGenerationStream(response);
            } catch (streamErr) {
                // A stop (or unmount) aborted this on purpose — rethrow so the
                // outer handler runs main's stop/refresh path untouched.
                if (generationAbort.signal.aborted) throw streamErr;
                // Otherwise the stream dropped on its own while the run keeps
                // executing server-side: reconnect once before giving up. The
                // resume borrows this run's controller, so a stop still stops.
                console.error(
                    "Generation stream interrupted, reconnecting",
                    streamErr,
                );
                await resumeGenerationStream();
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
        // The server gates `model` in the same content.edit arm as the
        // title and document set, so this gate must too. The old bare
        // `is_owner === false` check was the file's last leftover of the
        // ownership model: it refused org admins and members a change the
        // server accepts, and mislabelled the refusal admin-tier.
        if (!requireContent(tPermissao("acaoAlterarModeloRevisao"))) return;
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
        if (!requireStructure(tPermissao("acaoAdicionarColunas"))) return;
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
        if (!requireStructure(tPermissao("acaoEditarColunas"))) return;
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
        if (!requireStructure(tPermissao("acaoExcluirColunas"))) return;
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
        // Removing documents deletes their cells — member tier, like every
        // other reshaping of the review.
        if (!requireStructure(tPermissao("acaoRemoverDocumentosRevisao")))
            return;
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
        if (!requireStructure(tPermissao("acaoLimparResultados"))) return;
        await clearResultsForRows([...selectedRowIds]);
    }

    async function handleClearAllResults() {
        if (!requireStructure(tPermissao("acaoLimparResultados"))) return;
        await clearResultsForRows(rows.map((row) => row.id));
    }

    /**
     * The details dialog edits a review's title and, when it is not locked to
     * a project, which project it belongs to. Those are two different server
     * rules, so they get two gates — but each gate is stated once and used
     * everywhere it applies, instead of one tier for opening the dialog and a
     * different one for saving from it.
     *
     * Title: `PATCH /tabular-review/:id` requires `content.edit` (member) —
     * 403 "Only a review editor can change review settings".
     */
    const canEditDetails = canEditContent;

    /**
     * Moving a review between projects is `creatorScopedAllowed` server-side
     * (backend/src/routes/tabular.ts) — the review's creator, or an admin
     * only once the creator's account is gone and `user_id` is null. It is
     * NOT `access.manage`: gating on admin let a project admin who did not
     * create the review through to a 403 the client had promised would work.
     */
    function canMoveReview(): boolean {
        if (!review) return false;
        if (review.user_id) return review.user_id === user?.id;
        return can(reviewRole, "container.delete");
    }

    function requestReviewDetails() {
        // Member-tier, matching the PATCH the dialog will issue. This used to
        // demand access.manage while the save path demanded content.edit, so
        // a member was told "only an admin can edit tabular review details"
        // about a save the server would have accepted.
        if (!canEditDetails) {
            if (roleKnown) {
                setOwnerOnlyAction({
                    action: tPermissao("acaoEditarDetalhesRevisao"),
                    requiredRole: "editor",
                });
            }
            return;
        }
        setDetailsOpen(true);
    }

    async function handleDetailsSave(values: {
        title: string;
        projectId?: string | null;
    }) {
        if (
            !review ||
            !requireStructure(tPermissao("acaoEditarDetalhesRevisao"))
        )
            return;
        // Only send project_id when it actually changes: moving a review
        // between projects is creator-only server-side, and sending an
        // unchanged value would 403 a member editing just the title.
        const nextProjectId = values.projectId ?? null;
        const projectChanged = nextProjectId !== (review.project_id ?? null);
        // Gate the move here so somebody who touched the project selector
        // gets an explanation instead of an unexplained failed save.
        if (projectChanged && !canMoveReview()) {
            setOwnerOnlyAction({
                title: t("revisaoView.somenteCriadorTitulo"),
                message: t("revisaoView.somenteCriadorMensagem"),
            });
            return;
        }
        const updated = await updateTabularReview(reviewId, {
            title: values.title,
            ...(projectChanged ? { project_id: nextProjectId } : {}),
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
        if (!can(reviewRole, "container.delete")) {
            if (roleKnown)
                setOwnerOnlyAction(tPermissao("acaoExcluirRevisao"));
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
        if (!requireStructure(tPermissao("acaoAplicarWorkflow"))) return;
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
                <input
                    ref={reviewFileUploadInputRef}
                    type="file"
                    accept={SUPPORTED_DOCUMENT_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        void handleDropReviewFiles(files);
                    }}
                />
                <input
                    ref={reviewFolderUploadInputRef}
                    type="file"
                    accept={SUPPORTED_DOCUMENT_ACCEPT}
                    multiple
                    className="hidden"
                    {...{ webkitdirectory: "", directory: "" }}
                    onChange={(event) => {
                        const files = Array.from(event.target.files ?? []);
                        event.target.value = "";
                        void handleDropReviewFiles(files);
                    }}
                />
                {/* Header */}
                <PageHeader
                    shrink
                    breadcrumbs={[
                        ...(projectId
                            ? [
                                  {
                                      label: t("revisaoView.projetos"),
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
                                            title: t(
                                                "revisaoView.voltarProjeto",
                                            ),
                                        }
                                      : {
                                            label: project?.name ?? "",
                                            onClick: () =>
                                                router.push(
                                                    `/projects/${projectId}`,
                                                ),
                                            title: t(
                                                "revisaoView.voltarProjeto",
                                            ),
                                        },
                              ]
                            : [
                                  {
                                      label: t(
                                          "revisaoView.revisoesTabulares",
                                      ),
                                      onClick: () =>
                                          router.push("/tabular-reviews"),
                                      title: t(
                                          "revisaoView.voltarRevisoesTabulares",
                                      ),
                                  },
                              ]),
                        ...(projectId
                            ? [
                                  {
                                      label: t(
                                          "revisaoView.revisoesTabulares",
                                      ),
                                      onClick: () =>
                                          router.push(
                                              `/projects/${projectId}/tabular-reviews`,
                                          ),
                                      title: t(
                                          "revisaoView.voltarRevisoesTabulares",
                                      ),
                                  },
                              ]
                            : []),
                        loading
                            ? {
                                  loading: true,
                                  skeletonClassName: "w-40",
                              }
                            : {
                                  label:
                                      review?.title ||
                                      t("revisaoView.revisaoSemTitulo"),
                              },
                    ]}
                    actionGroups={[
                        [
                            {
                                type: "search",
                                value: search,
                                onChange: setSearch,
                                placeholder: t("revisaoView.buscarLinhas"),
                            },
                            !projectId
                                ? {
                                      onClick: () => setAccessModalOpen(true),
                                      disabled: loading,
                                      iconOnly: true,
                                      title: t("revisaoView.acesso"),
                                      icon: <Users className="h-4 w-4" />,
                                  }
                                : null,
                            {
                                type: "custom",
                                render: (
                                    <HeaderActionsMenu
                                        items={[
                                            {
                                                label: t(
                                                    "revisaoView.editarDetalhes",
                                                ),
                                                icon: Pencil,
                                                onSelect: requestReviewDetails,
                                                disabled: !roleKnown,
                                            },
                                            {
                                                label: t(
                                                    "revisaoView.aplicarWorkflow",
                                                ),
                                                icon: WandSparkles,
                                                onSelect: requestWorkflow,
                                                disabled: !roleKnown,
                                            },
                                            {
                                                label: t("revisaoView.exportar"),
                                                icon: Download,
                                                onSelect: () =>
                                                    exportTabularReviewToExcel({
                                                        reviewTitle:
                                                            review?.title ||
                                                            t(
                                                                "table.revisaoTabular",
                                                            ),
                                                        columns,
                                                        rows,
                                                        cells,
                                                    }),
                                                disabled:
                                                    columns.length === 0 ||
                                                    rows.length === 0,
                                            },
                                            {
                                                label: t(
                                                    "revisaoView.limparResultados",
                                                ),
                                                icon: X,
                                                onSelect: handleClearAllResults,
                                                disabled:
                                                    !roleKnown ||
                                                    rows.length === 0 ||
                                                    cellMutationsBlocked,
                                            },
                                            {
                                                label: t(
                                                    "revisaoView.excluir",
                                                ),
                                                icon: Trash2,
                                                onSelect: requestReviewDelete,
                                                variant: "danger",
                                                disabled: !roleKnown,
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
                                        <DocumentUploadMenu
                                            onSavedFiles={() => {
                                                // Same pre-modal gate as
                                                // openNewReview: stop viewers
                                                // before the modal, not after
                                                // a doomed submit.
                                                if (
                                                    !requireStructure(
                                                        tPermissao("acaoEditarConjuntoDocumentos"),
                                                    )
                                                )
                                                    return;
                                                setAddDocsOpen(true);
                                            }}
                                            onUploadFiles={() => {
                                                if (
                                                    !requireStructure(
                                                        tPermissao("acaoEditarConjuntoDocumentos"),
                                                    )
                                                )
                                                    return;
                                                reviewFileUploadInputRef.current?.click();
                                            }}
                                            onUploadFolder={() => {
                                                if (
                                                    !requireStructure(
                                                        tPermissao("acaoEditarConjuntoDocumentos"),
                                                    )
                                                )
                                                    return;
                                                reviewFolderUploadInputRef.current?.click();
                                            }}
                                            disabled={
                                                !roleKnown ||
                                                loading ||
                                                savingColumnsConfig ||
                                                uploadingDroppedFilenames.length >
                                                    0
                                            }
                                        />
                                    ),
                                },
                            ],
                        },
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
                                    onClick: generating
                                        ? handleStopGeneration
                                        : handleGenerate,
                                    disabled:
                                        stoppingGeneration ||
                                        columns.length === 0 ||
                                        rows.length === 0 ||
                                        savingColumnsConfig,
                                    title: stoppingGeneration
                                        ? t("revisaoView.parandoGeracao")
                                        : generating
                                          ? t("revisaoView.pararGeracao")
                                          : t("revisaoView.executarRevisao"),
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
                                                ? t("revisaoView.parando")
                                                : generating
                                                  ? t("revisaoView.parar")
                                                  : t("revisaoView.executar")}
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
                                        ? t("revisaoView.fecharChat")
                                        : t("revisaoView.abrirChat"),
                                    icon: chatOpen ? (
                                        <MessageSquareX className="h-4 w-4" />
                                    ) : (
                                        <MessageSquare className="h-4 w-4" />
                                    ),
                                    label: (
                                        <span className="hidden sm:inline">
                                            {t("revisaoView.chat")}
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
                                                    {t("revisaoView.acoes")}
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
                                                            {t(
                                                                "revisaoView.limparResultados",
                                                            )}
                                                        </button>
                                                        <button
                                                            onClick={
                                                                handleDeleteDocuments
                                                            }
                                                            className="w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 transition-colors"
                                                        >
                                                            {t(
                                                                "revisaoView.excluir",
                                                            )}
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
                                                {t(
                                                    "revisaoView.limparResultados",
                                                )}
                                            </TabPillButton>
                                            <TabPillButton
                                                onClick={handleDeleteDocuments}
                                                className="md:hidden text-red-600"
                                            >
                                                {t("revisaoView.excluir")}
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
                                            {t(
                                                "revisaoView.adicionarColunas",
                                            )}
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
                                onAddDocuments={() => {
                                    if (
                                        !requireStructure(
                                            tPermissao("acaoEditarConjuntoDocumentos"),
                                        )
                                    )
                                        return;
                                    setAddDocsOpen(true);
                                }}
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
                            canSend={canEditContent}
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
                        t("revisaoView.projetos"),
                        project.name +
                            (project.cm_number
                                ? ` (#${project.cm_number})`
                                : ""),
                        t("revisaoView.revisoesTabulares"),
                        ...(review
                            ? [
                                  review.title ||
                                      t("revisaoView.revisaoSemTitulo"),
                              ]
                            : []),
                        t("revisaoView.adicionarDocumentos"),
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
                        t("revisaoView.revisoesTabulares"),
                        ...(review
                            ? [
                                  review.title ||
                                      t("revisaoView.revisaoSemTitulo"),
                              ]
                            : []),
                        t("revisaoView.adicionarDocumentos"),
                    ]}
                    uploadStateId={`tabular-review:${review?.id ?? "new"}:library`}
                    tabs={["files", "projects"]}
                />
            )}

            <TabularReviewDetailsModal
                open={detailsOpen}
                review={review}
                projects={project ? [project] : availableProjects}
                canEdit={canEditDetails}
                lockProject={Boolean(projectId)}
                onClose={() => setDetailsOpen(false)}
                onSave={handleDetailsSave}
            />

            <AccessModal
                open={accessModalOpen}
                onClose={() => setAccessModalOpen(false)}
                resource={review}
                fetchAccess={getTabularReviewPeople}
                currentUserEmail={user?.email ?? null}
                breadcrumb={[
                    t("revisaoView.revisoesTabulares"),
                    review?.title || t("revisaoView.revisaoSemTitulo"),
                    t("revisaoView.acesso"),
                ]}
                access={{
                    grants: grants ?? [],
                    orgId: null,
                    ownerLabel: t("revisaoView.proprietariosRevisao"),
                    resourceKind: "tabular_review",
                    inheritedFromProjectId: review?.project_id ?? null,
                    canManage: can(reviewRole, "access.manage"),
                    onGrant: async (email, role) => {
                        await grantTabularReviewAccess(reviewId, email, role);
                        await refreshGrants();
                    },
                    onRevoke: async (email) => {
                        await revokeTabularReviewAccess(reviewId, email);
                        await refreshGrants();
                    },
                }}
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
                              t("revisaoView.projetos"),
                              project.name +
                                  (project.cm_number
                                      ? ` (#${project.cm_number})`
                                      : ""),
                          ]
                        : []),
                    t("revisaoView.revisoesTabulares"),
                    review?.title || t("revisaoView.revisaoSemTitulo"),
                    t("revisaoView.adicionarWorkflow"),
                ]}
                applying={applyingWorkflow}
            />

            <ConfirmPopup
                open={deleteReviewConfirmOpen}
                title={t("revisaoView.confirmarExclusaoTitulo")}
                message={t("revisaoView.confirmarExclusaoMensagem")}
                confirmLabel={t("revisaoView.excluir")}
                confirmVariant="danger"
                confirmStatus={
                    deleteReviewStatus === "deleting"
                        ? "loading"
                        : deleteReviewStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel={t("revisaoView.cancelar")}
                onCancel={() => {
                    if (deleteReviewStatus === "deleting") return;
                    setDeleteReviewConfirmOpen(false);
                    setDeleteReviewStatus("idle");
                }}
                onConfirm={() => void confirmReviewDelete()}
            />

            <PermissionDeniedPopup
                {...permissionDeniedProps(ownerOnlyAction, deniedContacts)}
                onClose={() => setOwnerOnlyAction(null)}
            />

            <WarningPopup
                open={dropUploadWarning !== null}
                onClose={() => setDropUploadWarning(null)}
                message={dropUploadWarning}
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
                title={t("revisaoView.selecioneModelo")}
                message={t("revisaoView.selecioneModeloMensagem")}
                onClose={() => setModelRequiredWarning(false)}
            />

            <WarningPopup
                open={generationGuard === "running"}
                title={t("revisaoView.jaEmExecucaoTitulo")}
                message={t("revisaoView.jaEmExecucaoMensagem")}
                onClose={() => {
                    if (!reloadingLatestReview) setGenerationGuard(null);
                }}
                primaryAction={{
                    label: reloadingLatestReview
                        ? t("revisaoView.verificando")
                        : t("revisaoView.verificarNovamente"),
                    disabled: reloadingLatestReview,
                    onClick: () => void loadLatestReview(),
                }}
            />

            <WarningPopup
                open={generationGuard === "stale"}
                title={t("revisaoView.versaoMaisRecenteTitulo")}
                message={t("revisaoView.versaoMaisRecenteMensagem")}
                onClose={() => {
                    if (!reloadingLatestReview) setGenerationGuard(null);
                }}
                primaryAction={{
                    label: reloadingLatestReview
                        ? t("revisaoView.carregando")
                        : t("revisaoView.carregarMaisRecente"),
                    disabled: reloadingLatestReview,
                    onClick: () => void loadLatestReview(),
                }}
            />
        </div>
    );
}
