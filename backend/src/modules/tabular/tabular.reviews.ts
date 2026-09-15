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
} from "../../lib/access";
import { can, type ProjectRole } from "../../lib/permissions";
import { loadProfileUsersByEmail } from "../../lib/userLookup";
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

    const selectedModel = await validateSelectedModel(model, userId, db);
    if (!selectedModel.ok) return modelFailure(selectedModel);

    if (project_id) {
        // Creating a review inside a project contributes content to it.
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
        );
        if (!access.ok || !can(access.projectRole, "content.edit"))
            return failure("not_found", "Project not found");
    }
    const allowedDocumentIds = Array.isArray(document_ids)
        ? await filterAccessibleDocumentIds(document_ids, userId, userEmail, db)
        : [];
    const grouping = normalizeGrouping(document_grouping);
    // Project reviews inherit their project's organization as tenant
    // provenance. Standalone reviews are always direct-scoped.
    const resolvedOrg = await resolveContentOrgId(db, {
        projectId: project_id ?? null,
    });
    if (!resolvedOrg.ok) return internalFailure(resolvedOrg.detail);
    if (org_id != null) {
        return failure(
            "validation",
            "Tabular reviews cannot be organization-scoped. Create the review inside an organization project instead.",
        );
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
    const rows = await loadReviewRows(db, reviewId);
    const rowDocIds = rows.flatMap((row) => row.source_document_ids ?? []);
    const docIds = Array.isArray(review.document_ids)
        ? (review.document_ids as string[])
        : rowDocIds;
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
            cells: (cells ?? []).map((cell) => ({
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
            org_id: null,
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
        }
        updates.project_id = projectIdUpdate;
        // `tabular_reviews.org_id` is a DENORMALIZED copy of the project's
        // tenant, stamped at creation and read directly by the SQL visibility
        // predicates (`tr.org_id is not null and exists (select 1 from
        // org_members …)`). Moving the review to another project changes
        // which tenant owns it, so the copy has to be restamped from the
        // destination — otherwise a review moved out of an org project into a
        // personal one keeps answering yes to that org arm and stays visible
        // to every member of an organization it no longer belongs to. Same
        // helper and argument shape as the create path.
        const movedOrg = await resolveContentOrgId(db, {
            projectId: projectIdUpdate ?? null,
        });
        if (!movedOrg.ok) return internalFailure(movedOrg.detail);
        updates.org_id = movedOrg.orgId;
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
