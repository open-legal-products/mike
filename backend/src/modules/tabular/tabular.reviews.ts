// Review-lifecycle services for the tabular module: the review record itself
// (list, create, detail, people, patch, delete) plus the row/cell scaffolding
// behind it — building a review's rows from its selected documents (grouped
// per document or per folder), rebuilding them when the selection changes, and
// reconciling the cell grid to the active column set.

import { recordAudit } from "../../lib/audit";
import {
    checkProjectAccess,
    creatorScopedAllowed,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    normalizeEmail,
    resolveContentOrgId,
    resolveStandaloneOrgId,
} from "../../lib/access";
import { teamOrgIdOf } from "../../lib/personalOrgs";
import {
    DOCUMENT_WORKSPACE_MISMATCH_CODE,
    DOCUMENT_WORKSPACE_MISMATCH_DETAIL,
    findDocumentsOutsideWorkspace,
} from "../../lib/documentWorkspace";
import { can, type ProjectRole } from "../../lib/permissions";
import { loadProfileUsersByEmail } from "../../lib/userLookup";
import { type WorkspaceFilter } from "../../lib/workspace";
import {
    deleteContentGrant,
    listContentGrants,
    upsertContentGrant,
    type ContentAccessGrant,
} from "../../lib/contentAccess";
import {
    listContentPeople,
    type ResourcePeopleResult,
} from "../../lib/resourcePeople";
import { attachActiveVersionPaths } from "../../lib/documentVersions";
import { TABULAR_MODEL_REQUIRED_DETAIL } from "../../lib/modelSelection";
import { failure, internalFailure } from "../../lib/serviceResult";
import {
    buildTabularReviewIdsOverviewRpcArgs,
    buildTabularReviewsOverviewRpcArgs,
    type TabularReviewScope,
} from "./tabular.overview";
import {
    fetchSourceDocuments,
    filterReadableReviewRows,
    loadReviewRows,
    type ReviewRow,
    type SourceDocument,
} from "./tabular.rows";
import {
    isReviewGenerationRunning,
    modelFailure,
    parseCellContent,
    statusFailure,
    validateSelectedModel,
    type Column,
    type Db,
    type TabularFailure,
    type TabularResult,
} from "./tabular.shared";

export type DocumentGrouping = "document" | "folder";

export function normalizeGrouping(value: unknown): DocumentGrouping {
    return value === "folder" ? "folder" : "document";
}

function buildFolderPathMap(
    folders: {
        id: string;
        name: string;
        parent_folder_id: string | null;
    }[],
): Map<string, string> {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const paths = new Map<string, string>();
    const resolve = (id: string): string => {
        const existing = paths.get(id);
        if (existing) return existing;
        const folder = byId.get(id);
        if (!folder) return "Unknown folder";
        const path = folder.parent_folder_id
            ? `${resolve(folder.parent_folder_id)} / ${folder.name}`
            : folder.name;
        paths.set(id, path);
        return path;
    };
    for (const folder of folders) resolve(folder.id);
    return paths;
}

async function getFolderPathMaps(
    db: Db,
    userId: string,
    docs: SourceDocument[],
): Promise<{
    project: Map<string, string>;
    library: Map<string, string>;
}> {
    const projectIds = [
        ...new Set(
            docs
                .map((doc) => doc.project_id)
                .filter((id): id is string => !!id),
        ),
    ];
    const [projectResult, libraryResult] = await Promise.all([
        projectIds.length
            ? db
                  .from("project_subfolders")
                  .select("id, name, parent_folder_id")
                  .in("project_id", projectIds)
            : Promise.resolve({ data: [] }),
        db
            .from("library_folders")
            .select("id, name, parent_folder_id")
            .eq("user_id", userId),
    ]);
    return {
        project: buildFolderPathMap(projectResult.data ?? []),
        library: buildFolderPathMap(libraryResult.data ?? []),
    };
}

export async function createRowsForReview(
    db: Db,
    reviewId: string,
    userId: string,
    documentIds: string[],
    columns: Column[],
    grouping: DocumentGrouping,
): Promise<void> {
    const docs = await fetchSourceDocuments(db, documentIds);
    const folderPaths = await getFolderPathMaps(db, userId, docs);
    const inputs: {
        label: string;
        row_type: "document" | "folder";
        folder_id: string | null;
        library_folder_id: string | null;
        document_id: string | null;
        sourceIds: string[];
    }[] = [];

    if (grouping === "folder") {
        const byFolder = new Map<
            string,
            {
                folder_id: string | null;
                library_folder_id: string | null;
                docs: SourceDocument[];
            }
        >();
        for (const doc of docs) {
            const folderKey = doc.folder_id
                ? `project:${doc.folder_id}`
                : doc.library_folder_id
                  ? `library:${doc.library_folder_id}`
                  : null;
            if (!folderKey) {
                inputs.push({
                    label: doc.filename,
                    row_type: "document",
                    folder_id: null,
                    library_folder_id: null,
                    document_id: doc.id,
                    sourceIds: [doc.id],
                });
                continue;
            }
            const existing = byFolder.get(folderKey);
            if (existing) {
                existing.docs.push(doc);
            } else {
                byFolder.set(folderKey, {
                    folder_id: doc.folder_id ?? null,
                    library_folder_id: doc.library_folder_id ?? null,
                    docs: [doc],
                });
            }
        }
        for (const folder of byFolder.values()) {
            const label = folder.folder_id
                ? folderPaths.project.get(folder.folder_id)
                : folder.library_folder_id
                  ? folderPaths.library.get(folder.library_folder_id)
                  : null;
            inputs.push({
                label: label ?? "Unknown folder",
                row_type: "folder",
                folder_id: folder.folder_id,
                library_folder_id: folder.library_folder_id,
                document_id: null,
                sourceIds: folder.docs.map((doc) => doc.id),
            });
        }
    } else {
        for (const doc of docs) {
            inputs.push({
                label: doc.filename,
                row_type: "document",
                folder_id: null,
                library_folder_id: null,
                document_id: doc.id,
                sourceIds: [doc.id],
            });
        }
    }

    inputs.sort((a, b) => a.label.localeCompare(b.label));
    if (inputs.length === 0) return;

    const { data, error } = await db
        .from("tabular_review_rows")
        .insert(
            inputs.map((input, sort_index) => ({
                review_id: reviewId,
                label: input.label,
                row_type: input.row_type,
                folder_id: input.folder_id,
                library_folder_id: input.library_folder_id,
                document_id: input.document_id,
                sort_index,
            })),
        )
        .select("*");
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as ReviewRow[]).sort(
        (a, b) => a.sort_index - b.sort_index,
    );
    const sources = rows.flatMap((row) =>
        (inputs[row.sort_index]?.sourceIds ?? []).map(
            (document_id, sort_index) => ({
                row_id: row.id,
                document_id,
                sort_index,
            }),
        ),
    );
    if (sources.length) {
        const { error: sourceError } = await db
            .from("tabular_review_row_sources")
            .insert(sources);
        if (sourceError) throw new Error(sourceError.message);
    }
    const cells = rows.flatMap((row) =>
        columns.map((column) => ({
            review_id: reviewId,
            row_id: row.id,
            document_id: row.document_id,
            column_index: column.index,
            status: "pending",
        })),
    );
    if (cells.length) {
        const { error: cellError } = await db
            .from("tabular_cells")
            .insert(cells);
        if (cellError) throw new Error(cellError.message);
    }
}

export async function rebuildRowsForReview(
    db: Db,
    reviewId: string,
    userId: string,
    documentIds: string[],
    columns: Column[],
    grouping: DocumentGrouping,
): Promise<void> {
    const { error } = await db
        .from("tabular_review_rows")
        .delete()
        .eq("review_id", reviewId);
    if (error) throw new Error(error.message);
    await createRowsForReview(
        db,
        reviewId,
        userId,
        documentIds,
        columns,
        grouping,
    );
}

export async function syncCellsForReviewRows(
    db: Db,
    reviewId: string,
    columns: Column[],
): Promise<void> {
    const { data: rows, error: rowsError } = await db
        .from("tabular_review_rows")
        .select("id,document_id")
        .eq("review_id", reviewId);
    if (rowsError) throw new Error(rowsError.message);
    const { data: cells, error: cellsError } = await db
        .from("tabular_cells")
        .select("id,row_id,column_index")
        .eq("review_id", reviewId);
    if (cellsError) throw new Error(cellsError.message);

    const activeColumnIndexes = new Set(columns.map((column) => column.index));
    const staleCellIds = (cells ?? [])
        .filter((cell) => !activeColumnIndexes.has(cell.column_index))
        .map((cell) => cell.id);
    if (staleCellIds.length) {
        const { error } = await db
            .from("tabular_cells")
            .delete()
            .in("id", staleCellIds);
        if (error) throw new Error(error.message);
    }

    const existingKeys = new Set(
        (cells ?? [])
            .filter((cell) => activeColumnIndexes.has(cell.column_index))
            .map((cell) => `${cell.row_id}:${cell.column_index}`),
    );
    const missingCells = (rows ?? []).flatMap((row) =>
        columns
            .filter((column) => !existingKeys.has(`${row.id}:${column.index}`))
            .map((column) => ({
                review_id: reviewId,
                row_id: row.id,
                document_id: row.document_id,
                column_index: column.index,
                status: "pending",
            })),
    );
    if (missingCells.length) {
        const { error } = await db.from("tabular_cells").insert(missingCells);
        if (error) throw new Error(error.message);
    }
}

// ---------------------------------------------------------------------------
// Review CRUD
// ---------------------------------------------------------------------------
//
// The endpoints below own the review record itself: the two overview listings,
// create, detail, the people roster, patch and delete. Each takes an explicit
// `db` and returns a typed result; the route only maps that result onto a
// status code.

export type ListReviewsFilters = {
    userId: string;
    userEmail: string | undefined;
    projectIdFilter: string | null;
    scope: TabularReviewScope;
    pagination: { limit: number; offset: number };
    searchTerm: string | null;
    sort: { key: string; direction: string };
    workspace?: WorkspaceFilter;
};

export async function listTabularReviews(
    db: Db,
    filters: ListReviewsFilters,
): Promise<TabularResult<unknown[]>> {
    const rpcArgs = buildTabularReviewsOverviewRpcArgs(filters);
    const { data, error } = await db.rpc(
        "get_tabular_reviews_overview",
        rpcArgs,
    );
    if (error) return internalFailure(error);
    return { ok: true, data: (data ?? []) as unknown[] };
}

// PostgREST enforces its own row cap on every RPC response (db-max-rows),
// independent of anything the caller asks for, and truncates silently
// (206 + a shorter array, no error) rather than failing. So this pages through
// the RPC itself — server-side, same-datacenter round trips — until a page
// comes back empty, rather than trusting one call to return everything.
const TABULAR_REVIEW_IDS_PAGE_SIZE = 1000;
const TABULAR_REVIEW_IDS_MAX_PAGES = 200; // guards a runaway loop, not a product limit

export type ReviewIdRow = { id: string; user_id: string };

export async function listTabularReviewIds(
    db: Db,
    filters: {
        userId: string;
        userEmail: string | undefined;
        projectIdFilter: string | null;
        scope: TabularReviewScope;
        searchTerm: string | null;
        workspace?: WorkspaceFilter;
    },
): Promise<TabularResult<ReviewIdRow[]>> {
    const ids: ReviewIdRow[] = [];
    let offset = 0;
    for (let page = 0; page < TABULAR_REVIEW_IDS_MAX_PAGES; page++) {
        const rpcArgs = buildTabularReviewIdsOverviewRpcArgs({
            ...filters,
            pagination: { limit: TABULAR_REVIEW_IDS_PAGE_SIZE, offset },
        });
        const { data, error } = await db.rpc(
            "get_tabular_review_ids_overview",
            rpcArgs,
        );
        if (error) return internalFailure(error);

        const rows = (data ?? []) as ReviewIdRow[];
        if (rows.length === 0) break;
        ids.push(...rows);
        offset += rows.length;
    }
    return { ok: true, data: ids };
}

export type CreateReviewInput = {
    userId: string;
    userEmail: string | undefined;
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
    org_id?: unknown;
    document_grouping?: DocumentGrouping;
    model?: unknown;
};

export async function createTabularReview(
    db: Db,
    input: CreateReviewInput,
): Promise<TabularResult<Record<string, unknown>>> {
    const {
        userId,
        userEmail,
        title,
        document_ids,
        columns_config,
        workflow_id,
        project_id,
        org_id,
        document_grouping,
        model,
    } = input;

    if (typeof model !== "string" || !model.trim()) {
        return statusFailure(400, {
            code: "model_required",
            detail: TABULAR_MODEL_REQUIRED_DETAIL,
        });
    }

    // The project is checked before the model: it decides whose keys the
    // review runs on (its organization's, when it has one).
    let projectOrgId: string | null = null;
    if (project_id) {
        // Creating a review inside a project contributes content to it.
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
        );
        // A Viewer can open the project, so "not found" would be a lie; the
        // read-only tier gets a refusal that names itself.
        if (!access.ok) return failure("not_found", "Project not found");
        if (!can(access.projectRole, "content.edit"))
            return failure(
                "forbidden",
                "You do not have permission to write in this project.",
            );
        projectOrgId = access.project.org_id ?? null;
    }

    // A review started on its own belongs to the workspace it was started
    // in: the organization the client names, or Personal when it names none.
    // Inside a project the project decides, and `org_id` is not consulted.
    let standaloneOrgId: string | null = null;
    if (!project_id) {
        const standalone = await resolveStandaloneOrgId(db, {
            userId,
            orgId: org_id,
        });
        if (!standalone.ok) return failure("validation", standalone.detail);
        standaloneOrgId = standalone.orgId;
    }

    const selectedModel = await validateSelectedModel(
        model,
        userId,
        db,
        project_id ? projectOrgId : standaloneOrgId,
    );
    if (!selectedModel.ok) return modelFailure(selectedModel);
    const allowedDocumentIds = Array.isArray(document_ids)
        ? await filterAccessibleDocumentIds(document_ids, userId, userEmail, db)
        : [];
    const grouping = normalizeGrouping(document_grouping);
    // Project reviews inherit their project's organization as tenant
    // provenance.
    const resolvedOrg = project_id
        ? await resolveContentOrgId(db, { projectId: project_id })
        : ({ ok: true, orgId: standaloneOrgId } as const);
    if (!resolvedOrg.ok) return internalFailure(resolvedOrg.detail);
    // A review is built from documents in its own workspace. Refused rather
    // than dropped: a review that quietly came out with fewer rows than were
    // chosen would look like a fault.
    try {
        const outside = await findDocumentsOutsideWorkspace(
            db,
            allowedDocumentIds,
            resolvedOrg.orgId,
        );
        if (outside.length > 0)
            return failure(
                "validation",
                DOCUMENT_WORKSPACE_MISMATCH_DETAIL,
                DOCUMENT_WORKSPACE_MISMATCH_CODE,
            );
    } catch (error) {
        return internalFailure(error);
    }
    const { data: review, error } = await db
        .from("tabular_reviews")
        .insert({
            user_id: userId,
            title: title ?? null,
            model: selectedModel.model,
            columns_config,
            document_ids: allowedDocumentIds,
            project_id: project_id ?? null,
            workflow_id: workflow_id ?? null,
            document_grouping: grouping,
            org_id: resolvedOrg.orgId,
        })
        .select("*")
        .single();
    if (error || !review)
        return internalFailure(
            error ?? new Error("Review create returned no data"),
        );

    try {
        await createRowsForReview(
            db,
            review.id,
            userId,
            allowedDocumentIds,
            columns_config,
            grouping,
        );
    } catch (rowsError) {
        await db.from("tabular_reviews").delete().eq("id", review.id);
        return statusFailure(500, {
            detail:
                rowsError instanceof Error
                    ? rowsError.message
                    : "Failed to create review rows",
        });
    }

    void recordAudit(db, {
        userId,
        userEmail,
        action: "tabular.created",
        orgId: resolvedOrg.orgId,
        title: (review as { title?: string | null }).title ?? null,
        surface: "tabular",
        projectId: project_id ?? null,
        reviewId: (review as { id: string }).id,
        model: selectedModel.model,
    });
    return {
        ok: true,
        data: {
            ...(review as Record<string, unknown>),
            is_owner: true,
            access_role: "owner",
        },
    };
}

export type ReviewDetail = {
    review: Record<string, unknown>;
    cells: Record<string, unknown>[];
    rows: ReviewRow[];
    documents: Record<string, unknown>[];
};

export async function getTabularReviewDetail(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<TabularResult<ReviewDetail>> {
    const { reviewId, userId, userEmail } = args;

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Review not found");

    const { data: cells, error: cellsError } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    if (cellsError) return internalFailure(cellsError);
    const allRows = await loadReviewRows(db, reviewId);
    const allRowDocIds = allRows.flatMap(
        (row) => row.source_document_ids ?? [],
    );
    const allDocIds = Array.isArray(review.document_ids)
        ? (review.document_ids as string[])
        : allRowDocIds;
    // Review access says who may open the grid, not whose documents they may
    // read. Rows, cells, and document metadata are narrowed to the caller's
    // own document access (see filterReadableReviewRows).
    const { rows, readableDocumentIds } = await filterReadableReviewRows(
        db,
        allRows,
        allDocIds,
        userId,
        userEmail,
    );
    const visibleRowIds = new Set(rows.map((row) => row.id));
    const docIds = allDocIds.filter((id) => readableDocumentIds.has(id));
    const docsResult =
        docIds.length > 0
            ? await db.from("documents").select("*").in("id", docIds)
            : { data: [] as Record<string, unknown>[] };
    const docs = (docsResult.data ?? []) as unknown as {
        id: string;
        current_version_id?: string | null;
    }[];
    await attachActiveVersionPaths(db, docs);
    const clientReview = { ...review };
    delete clientReview.active_generation_id;
    delete clientReview.generation_lease_expires_at;

    return {
        ok: true,
        data: {
            review: {
                ...clientReview,
                is_owner: access.isCreator,
                access_role: access.projectRole,
                is_running: isReviewGenerationRunning(review),
            },
            cells: (cells ?? [])
                .filter((cell) => visibleRowIds.has(cell.row_id as string))
                .map((cell) => ({
                    ...cell,
                    content: parseCellContent(cell.content),
                })),
            rows,
            documents: docs as unknown as Record<string, unknown>[],
        },
    };
}

/** A review row as the access/people endpoints need it. */
type ReviewAccessRow = {
    id: string;
    user_id: string | null;
    project_id: string | null;
    org_id?: string | null;
};

export type ReviewPeople = Extract<ResourcePeopleResult, { ok: true }>;

export async function getTabularReviewPeople(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<TabularResult<ReviewPeople>> {
    const { reviewId, userId, userEmail } = args;

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .single();
    if (!review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Review not found");

    const people = await listContentPeople(
        db,
        "tabular_review",
        review as ReviewAccessRow,
    );
    if (!people.ok) return internalFailure(people.detail);
    return { ok: true, data: people };
}

// ---------------------------------------------------------------------------
// Direct access grants
// ---------------------------------------------------------------------------
//
// The trio behind GET/POST /:reviewId/access and DELETE
// /:reviewId/access/:email. All three share one preamble — load the review,
// derive the caller's role, and refuse anyone below `access.manage` — so it
// lives in a helper rather than being restated (and drifting) three times.

export type ReviewAccessSummary = {
    scope: "project" | "direct";
    inherited_from_project_id?: string;
    org_id: string | null;
    access_role: ProjectRole;
    grants: ContentAccessGrant[];
};

async function ensureReviewAccessManager(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<
    | { ok: true; review: ReviewAccessRow; projectRole: ProjectRole }
    | TabularFailure
> {
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", args.reviewId)
        .maybeSingle();
    if (!review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(
        review,
        args.userId,
        args.userEmail,
        db,
    );
    if (!access.ok) return failure("not_found", "Review not found");
    if (!can(access.projectRole, "access.manage"))
        return failure(
            "forbidden",
            "Only a review owner can change who has access.",
        );
    return {
        ok: true,
        review: review as ReviewAccessRow,
        projectRole: access.projectRole,
    };
}

/** Role-aware direct grants, admin-only. */
export async function getTabularReviewAccess(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<TabularResult<ReviewAccessSummary>> {
    const gate = await ensureReviewAccessManager(db, args);
    if (!gate.ok) return gate;
    const { review, projectRole } = gate;
    if (review.project_id)
        return {
            ok: true,
            data: {
                scope: "project",
                inherited_from_project_id: review.project_id,
                org_id: review.org_id ?? null,
                access_role: projectRole,
                grants: [],
            },
        };
    const listed = await listContentGrants(db, "tabular_review", args.reviewId);
    if (!listed.ok) return internalFailure(listed.detail);
    return {
        ok: true,
        data: {
            scope: "direct",
            // The organization whose members it can be shared with, or null
            // for a personal review, which can be shared with anyone.
            org_id: await teamOrgIdOf(db, review.org_id),
            access_role: projectRole,
            grants: listed.grants,
        },
    };
}

/** Grant or re-role one recipient on a standalone review. */
export async function grantTabularReviewAccess(
    db: Db,
    args: {
        reviewId: string;
        userId: string;
        userEmail: string | undefined;
        email: unknown;
        role: unknown;
    },
): Promise<TabularResult<ContentAccessGrant>> {
    const gate = await ensureReviewAccessManager(db, args);
    if (!gate.ok) return gate;
    if (gate.review.project_id)
        return failure(
            "conflict",
            "Project-owned reviews inherit access from their project.",
            "access_inherited",
        );
    const email = normalizeEmail(
        typeof args.email === "string" ? args.email : null,
    );
    if (email && normalizeEmail(args.userEmail) === email)
        return failure(
            "validation",
            "You cannot share a tabular review with yourself.",
        );
    if (args.role === "deny")
        return failure(
            "validation",
            "Deny is only available for organization members",
        );
    const { userById } = await loadProfileUsersByEmail(db);
    const result = await upsertContentGrant(db, {
        kind: "tabular_review",
        resourceId: args.reviewId,
        email: args.email,
        role: args.role,
        createdBy: args.userId,
        orgId: await teamOrgIdOf(db, gate.review.org_id),
        creatorEmail: gate.review.user_id
            ? userById.get(gate.review.user_id)?.email
            : null,
    });
    if (!result.ok) {
        if (result.kind === "validation")
            return failure("validation", result.detail);
        return internalFailure(result.detail);
    }
    return { ok: true, data: result.grant };
}

/** Revoke one recipient's direct grant. */
export async function revokeTabularReviewAccess(
    db: Db,
    args: {
        reviewId: string;
        userId: string;
        userEmail: string | undefined;
        email: string;
    },
): Promise<TabularResult<null>> {
    const gate = await ensureReviewAccessManager(db, args);
    if (!gate.ok) return gate;
    if (gate.review.project_id)
        return failure(
            "conflict",
            "Project-owned reviews inherit access from their project.",
            "access_inherited",
        );
    const result = await deleteContentGrant(db, {
        kind: "tabular_review",
        resourceId: args.reviewId,
        email: args.email,
    });
    if (!result.ok) return internalFailure(result.detail);
    if (!result.removed) return failure("not_found", "Access grant not found");
    return { ok: true, data: null };
}

export async function updateTabularReview(
    db: Db,
    args: {
        reviewId: string;
        userId: string;
        userEmail: string | undefined;
        body: Record<string, unknown>;
    },
): Promise<TabularResult<Record<string, unknown>>> {
    const { reviewId, userId, userEmail, body } = args;

    if ("shared_with" in body)
        return failure(
            "validation",
            "shared_with is no longer supported; use the tabular review access endpoints.",
        );
    const updates: Record<string, unknown> = {};
    if (body.title != null) updates.title = body.title;
    const modelUpdateProvided = body.model !== undefined;
    const projectIdUpdateProvided = body.project_id !== undefined;
    const projectIdUpdate =
        body.project_id === null
            ? null
            : typeof body.project_id === "string" && body.project_id.trim()
              ? body.project_id.trim()
              : undefined;
    if (projectIdUpdateProvided && projectIdUpdate === undefined) {
        return failure(
            "validation",
            "project_id must be a non-empty string or null",
        );
    }
    updates.updated_at = new Date().toISOString();

    const { data: existingReview, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !existingReview)
        return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(
        existingReview,
        userId,
        userEmail,
        db,
    );
    if (!access.ok) return failure("not_found", "Review not found");
    // Per-field gates, generalising #175's owner-only "settings" rule to
    // the role ladder. Title, document set and column set are content work
    // (member+): reshaping the grid destroys cells when narrowed, but so does
    // any other edit a member may already make. Sharing is admin-only — it
    // changes WHO can reach the review, which is a different kind of power.
    // Moving the review between projects stays with its creator.
    if (
        (body.title != null ||
            Array.isArray(body.document_ids) ||
            body.document_grouping != null ||
            modelUpdateProvided) &&
        !can(access.projectRole, "content.edit")
    ) {
        return failure(
            "forbidden",
            "Only a review editor can change review settings",
        );
    }
    if (modelUpdateProvided) {
        const selectedModel = await validateSelectedModel(
            body.model,
            userId,
            db,
            existingReview.org_id ?? null,
        );
        if (!selectedModel.ok) return modelFailure(selectedModel);
        updates.model = selectedModel.model;
    }
    if (body.columns_config != null) {
        if (!can(access.projectRole, "content.edit")) {
            return failure(
                "forbidden",
                "Only a review editor can change columns",
            );
        }
        updates.columns_config = body.columns_config;
    }
    if (body.document_grouping != null) {
        if (
            body.document_grouping !== "document" &&
            body.document_grouping !== "folder"
        ) {
            return failure(
                "validation",
                "document_grouping must be document or folder",
            );
        }
        updates.document_grouping = body.document_grouping;
    }
    if (Array.isArray(body.document_ids)) {
        updates.document_ids = await filterAccessibleDocumentIds(
            body.document_ids as string[],
            userId,
            userEmail,
            db,
        );
    }
    if (projectIdUpdateProvided) {
        if (!creatorScopedAllowed(access, existingReview.user_id)) {
            return failure(
                "forbidden",
                "Only the review's creator can move a review",
            );
        }
        // Authorship is not standing. A creator whose role on the review's
        // current project was reduced to Viewer must not be able to pull the
        // review (cells, document list) out of that matter into personal
        // scope, so moving needs write access where the review lives now…
        if (!can(access.projectRole, "content.edit")) {
            return failure(
                "forbidden",
                "You do not have permission to move this review.",
            );
        }
        if (projectIdUpdate) {
            const projectAccess = await checkProjectAccess(
                projectIdUpdate,
                userId,
                userEmail,
                db,
            );
            if (!projectAccess.ok) {
                return failure("not_found", "Target project not found");
            }
            // …and where it is going: a move contributes the review to the
            // destination's members exactly as creating it there would, so it
            // takes the same content.edit gate as the create path.
            if (!can(projectAccess.projectRole, "content.edit")) {
                return failure(
                    "forbidden",
                    "You do not have permission to write in this project.",
                );
            }
        }
        updates.project_id = projectIdUpdate;
        // `tabular_reviews.org_id` is the organization the review belongs
        // to, read directly by the SQL access rule (review_access_role). In a
        // project it is a copy of the project's, so a move restamps it from
        // the destination.
        //
        // What belongs to a team organization stays in it. Taken out of its
        // project, such a review becomes a standalone review of the same
        // organization rather than its mover's personal property; and it
        // cannot be moved into a project somewhere else.
        const currentOrgId = await teamOrgIdOf(
            db,
            (existingReview.org_id as string | null | undefined) ?? null,
        );
        if (projectIdUpdate) {
            const movedOrg = await resolveContentOrgId(db, {
                projectId: projectIdUpdate,
            });
            if (!movedOrg.ok) return internalFailure(movedOrg.detail);
            if (currentOrgId && movedOrg.orgId !== currentOrgId)
                return failure(
                    "validation",
                    "This review belongs to an organization and can only be moved to a project in the same organization.",
                );
            updates.org_id = movedOrg.orgId;
        } else {
            updates.org_id = currentOrgId;
        }
    }

    // A review is built from documents in its own workspace. Documents it
    // already has are let through while it stays where it is — a review from
    // before this rule keeps working — but a move into another workspace
    // takes every document with it, so there all of them are looked at.
    if (Array.isArray(body.document_ids) || projectIdUpdateProvided) {
        try {
            const existingDocumentIds = (existingReview.document_ids ??
                []) as string[];
            const nextDocumentIds =
                (updates.document_ids as string[] | undefined) ??
                existingDocumentIds;
            const currentOrgId = await teamOrgIdOf(
                db,
                (existingReview.org_id as string | null | undefined) ?? null,
            );
            const nextOrgId = projectIdUpdateProvided
                ? await teamOrgIdOf(db, updates.org_id as string | null)
                : currentOrgId;
            const moved = nextOrgId !== currentOrgId;
            const toCheck = moved
                ? nextDocumentIds
                : nextDocumentIds.filter(
                      (id) => !existingDocumentIds.includes(id),
                  );
            const outside = await findDocumentsOutsideWorkspace(
                db,
                toCheck,
                nextOrgId,
            );
            if (outside.length > 0)
                return failure(
                    "validation",
                    moved
                        ? "This review uses documents from the workspace it is in, so it cannot be moved to a project in another one."
                        : DOCUMENT_WORKSPACE_MISMATCH_DETAIL,
                    DOCUMENT_WORKSPACE_MISMATCH_CODE,
                );
        } catch (error) {
            return internalFailure(error);
        }
    }

    const { data: updatedReview, error: updateError } = await db
        .from("tabular_reviews")
        .update(updates)
        .eq("id", reviewId)
        .select("*")
        .single();
    if (updateError || !updatedReview)
        return internalFailure(
            updateError ?? new Error("Review update returned no data"),
        );

    const rowShapeChanged =
        Array.isArray(body.document_ids) ||
        body.document_grouping != null ||
        projectIdUpdateProvided;
    try {
        const activeColumns = (updatedReview.columns_config ?? []) as Column[];
        if (rowShapeChanged) {
            await rebuildRowsForReview(
                db,
                reviewId,
                userId,
                (updatedReview.document_ids ?? []) as string[],
                activeColumns,
                normalizeGrouping(updatedReview.document_grouping),
            );
        } else if (Array.isArray(body.columns_config)) {
            await syncCellsForReviewRows(db, reviewId, activeColumns);
        }
    } catch (syncError) {
        return statusFailure(500, {
            detail:
                syncError instanceof Error
                    ? syncError.message
                    : "Failed to synchronize review rows",
        });
    }

    return { ok: true, data: updatedReview as Record<string, unknown> };
}

export async function deleteTabularReview(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<TabularResult<null>> {
    const { reviewId, userId, userEmail } = args;
    // container.delete keeps review deletion at the top of the ladder: the
    // review's own creator, or an admin of the project it lives in (who could
    // already delete the whole project, review included). The old
    // `.eq("user_id", userId)` filter made that project admin's DELETE a
    // silent 204 no-op — the row survived and the UI showed it again on the
    // next load. Resolving the role first also lets members and viewers learn
    // they were refused (403) instead of guessing at a 404.
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, org_id")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review) return failure("not_found", "Review not found");
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return failure("not_found", "Review not found");
    if (!can(access.projectRole, "container.delete"))
        return failure(
            "forbidden",
            "You do not have permission to delete this review",
        );

    const { error } = await db
        .from("tabular_reviews")
        .delete()
        .eq("id", reviewId);
    if (error) return internalFailure(error);
    return { ok: true, data: null };
}
