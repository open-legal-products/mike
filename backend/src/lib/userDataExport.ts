import { sealManifest } from "./manifestSigning";
import type { Db } from "./supabase";

const PAGE_SIZE = 1000;

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

export function userExportFilename(
    kind: "account" | "chats" | "tabular-reviews",
    userId: string,
) {
    return `mike-${kind}-export-${userId.slice(0, 8)}-${nowStamp()}.json`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))];
}

async function throwIfError<T extends { message?: string } | null>(
    error: T,
    context: string,
) {
    if (error) throw new Error(`${context}: ${error.message ?? "unknown error"}`);
}

async function selectAll(
    db: Db,
    table: string,
    configure: (query: any) => any,
    columns = "*",
): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];

    for (let from = 0; ; from += PAGE_SIZE) {
        const to = from + PAGE_SIZE - 1;
        const query = configure(
            (db as any)
                .from(table)
                .select(columns)
                .range(from, to),
        );
        const { data, error } = await query;
        await throwIfError(error, `Failed to export ${table}`);
        const batch = (data ?? []) as Record<string, unknown>[];
        rows.push(...batch);
        if (batch.length < PAGE_SIZE) break;
    }

    return rows;
}

async function selectByIds(
    db: Db,
    table: string,
    column: string,
    ids: string[],
): Promise<Record<string, unknown>[]> {
    if (ids.length === 0) return [];
    return selectAll(db, table, (query) => query.in(column, ids));
}

function idsFrom(rows: Record<string, unknown>[], column = "id"): string[] {
    return uniqueStrings(
        rows.map((row) =>
            typeof row[column] === "string" ? (row[column] as string) : null,
        ),
    );
}

async function loadUserChats(db: Db, userId: string) {
    const chats = await selectAll(db, "chats", (query) =>
        query.eq("user_id", userId).order("created_at", { ascending: true }),
    );
    const chatIds = idsFrom(chats);
    const messages = await selectByIds(db, "chat_messages", "chat_id", chatIds);
    return { chats, messages };
}

async function loadUserWordChats(db: Db, userId: string) {
    const documents = await selectAll(db, "word_documents", (query) =>
        query.eq("user_id", userId).order("created_at", { ascending: true }),
    );
    const chats = await selectAll(db, "word_chats", (query) =>
        query.eq("user_id", userId).order("created_at", { ascending: true }),
    );
    const messages = await selectByIds(
        db,
        "word_chat_messages",
        "chat_id",
        idsFrom(chats),
    );
    return { documents, chats, messages };
}

async function loadUserTabularChats(db: Db, userId: string) {
    const chats = await selectAll(db, "tabular_review_chats", (query) =>
        query.eq("user_id", userId).order("created_at", { ascending: true }),
    );
    const chatIds = idsFrom(chats);
    const messages = await selectByIds(
        db,
        "tabular_review_chat_messages",
        "chat_id",
        chatIds,
    );
    return { chats, messages };
}

async function loadApiKeyStatus(db: Db, userId: string) {
    const rows = await selectAll(db, "user_api_keys", (query) =>
        query
            .eq("user_id", userId)
            .order("provider", { ascending: true }),
        "provider, created_at, updated_at",
    );
    return rows.map((row) => ({
        provider: row.provider,
        has_key: true,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }));
}

export async function buildUserChatsExport(
    db: Db,
    userId: string,
    userEmail?: string | null,
) {
    const [assistant, wordAddin, tabular] = await Promise.all([
        loadUserChats(db, userId),
        loadUserWordChats(db, userId),
        loadUserTabularChats(db, userId),
    ]);

    return {
        exported_at: new Date().toISOString(),
        user: { id: userId, email: userEmail ?? null },
        assistant_chats: assistant,
        word_addin_chats: wordAddin,
        tabular_review_chats: tabular,
    };
}

export async function buildUserTabularReviewsExport(
    db: Db,
    userId: string,
    userEmail?: string | null,
) {
    const tabularReviews = await selectAll(db, "tabular_reviews", (query) =>
        query.eq("user_id", userId).order("created_at", { ascending: true }),
    );
    const reviewIds = idsFrom(tabularReviews);

    const [cells, chats] = await Promise.all([
        selectByIds(db, "tabular_cells", "review_id", reviewIds),
        selectByIds(db, "tabular_review_chats", "review_id", reviewIds),
    ]);
    const chatIds = idsFrom(chats);
    const messages = await selectByIds(
        db,
        "tabular_review_chat_messages",
        "chat_id",
        chatIds,
    );

    return {
        exported_at: new Date().toISOString(),
        user: { id: userId, email: userEmail ?? null },
        tabular_reviews: tabularReviews,
        tabular_cells: cells,
        tabular_review_chats: {
            chats,
            messages,
        },
    };
}

export function projectManifestFilename(projectId: string) {
    return `mike-project-manifest-${projectId.slice(0, 8)}-${nowStamp()}.json`;
}

/**
 * Tamper-evident manifest for one project: every document version with its
 * content_sha256, plus the accept/reject trail. To check an exported file
 * against what the workspace held, recompute its SHA-256 and compare.
 *
 * `sealManifest` then hashes the body and signs that digest with the
 * deployment's Ed25519 key, if it has one. Unsigned, the manifest shows the
 * *files* are unmodified but says nothing about itself.
 *
 * Versions written before content hashing shipped carry a null hash rather
 * than a wrong one, so an old file set reads as unverifiable and never as
 * verified.
 */
export async function buildProjectExportManifest(db: Db, projectId: string) {
    const { data: project, error: projectError } = await db
        .from("projects")
        .select("id, name, cm_number, created_at")
        .eq("id", projectId)
        .single();
    await throwIfError(projectError, "Failed to export project");

    const documents = await selectAll(
        db,
        "documents",
        (query) =>
            query
                .eq("project_id", projectId)
                .order("created_at", { ascending: true })
                .order("id", { ascending: true }),
        "id, project_id, status, current_version_id, created_at",
    );
    const documentIds = idsFrom(documents);

    const [versions, edits] = await Promise.all([
        documentIds.length === 0
            ? Promise.resolve([])
            : selectAll(
                  db,
                  "document_versions",
                  (query) =>
                      query
                          .in("document_id", documentIds)
                          .order("created_at", { ascending: true })
                          .order("id", { ascending: true }),
                  "id, document_id, version_number, source, filename, file_type, size_bytes, content_sha256, deleted_at, created_at",
              ),
        documentIds.length === 0
            ? Promise.resolve([])
            : selectAll(
                  db,
                  "document_edits",
                  (query) =>
                      query
                          .in("document_id", documentIds)
                          .order("created_at", { ascending: true })
                          .order("id", { ascending: true }),
                  "id, document_id, version_id, change_id, status, created_at, resolved_at",
              ),
    ]);

    const groupByDocument = (rows: Record<string, unknown>[]) => {
        const byDoc = new Map<string, Record<string, unknown>[]>();
        for (const row of rows) {
            const docId = row.document_id as string;
            const list = byDoc.get(docId) ?? [];
            list.push(row);
            byDoc.set(docId, list);
        }
        return byDoc;
    };
    const versionsByDoc = groupByDocument(versions);
    const editsByDoc = groupByDocument(edits);

    return sealManifest({
        manifest_version: 1,
        exported_at: new Date().toISOString(),
        project,
        documents: documents.map((doc) => ({
            id: doc.id,
            status: doc.status,
            current_version_id: doc.current_version_id,
            created_at: doc.created_at,
            versions: (versionsByDoc.get(doc.id as string) ?? []).map((v) => ({
                id: v.id,
                version_number: v.version_number,
                source: v.source,
                filename: v.filename,
                file_type: v.file_type,
                size_bytes: v.size_bytes,
                content_sha256: v.content_sha256,
                deleted_at: v.deleted_at,
                created_at: v.created_at,
            })),
            edits: (editsByDoc.get(doc.id as string) ?? []).map((e) => ({
                id: e.id,
                version_id: e.version_id,
                change_id: e.change_id,
                status: e.status,
                created_at: e.created_at,
                resolved_at: e.resolved_at,
            })),
        })),
    });
}

export async function buildUserAccountExport(
    db: Db,
    userId: string,
    userEmail?: string | null,
) {
    const [
        profile,
        apiKeys,
        routerModels,
        projects,
        standaloneDocuments,
        workflows,
        defaultWorkflowInstallations,
        quickActions,
        workflowOpenSourceSubmissions,
        hiddenWorkflows,
        workflowSharesByUser,
        workflowSharesWithUser,
        assistantChats,
        tabularChats,
        tabularReviews,
        sharedProjects,
        sharedTabularReviews,
        auditEvents,
    ] = await Promise.all([
        selectAll(db, "user_profiles", (query) => query.eq("user_id", userId)),
        loadApiKeyStatus(db, userId),
        selectAll(db, "user_router_models", (query) =>
            query
                .eq("user_id", userId)
                .order("router", { ascending: true })
                .order("sort_order", { ascending: true }),
        ),
        selectAll(db, "projects", (query) =>
            query.eq("user_id", userId).order("created_at", { ascending: true }),
        ),
        selectAll(db, "documents", (query) =>
            query
                .eq("user_id", userId)
                .is("project_id", null)
                .order("created_at", { ascending: true }),
        ),
        selectAll(db, "workflows", (query) =>
            query.eq("user_id", userId).order("created_at", { ascending: true }),
        ),
        selectAll(db, "default_workflow_installations", (query) =>
            query.eq("user_id", userId).order("installed_at", { ascending: true }),
        ),
        selectAll(db, "quick_actions", (query) =>
            query.eq("user_id", userId).order("sort_order", { ascending: true }),
        ),
        selectAll(db, "workflow_open_source_submissions", (query) =>
            query
                .eq("submitted_by_user_id", userId)
                .order("submitted_at", { ascending: true }),
        ),
        selectAll(db, "hidden_workflows", (query) =>
            query.eq("user_id", userId).order("created_at", { ascending: true }),
        ),
        selectAll(db, "workflow_shares", (query) =>
            query
                .eq("shared_by_user_id", userId)
                .order("created_at", { ascending: true }),
        ),
        userEmail
            ? selectAll(db, "workflow_shares", (query) =>
                  query
                      .eq("shared_with_email", userEmail)
                      .order("created_at", { ascending: true }),
              )
            : Promise.resolve([]),
        loadUserChats(db, userId),
        loadUserTabularChats(db, userId),
        selectAll(db, "tabular_reviews", (query) =>
            query.eq("user_id", userId).order("created_at", { ascending: true }),
        ),
        userEmail
            ? selectAll(db, "projects", (query) =>
                  query
                      .filter(
                          "shared_with",
                          "cs",
                          JSON.stringify([userEmail.trim().toLowerCase()]),
                      )
                      .neq("user_id", userId)
                      .order("created_at", { ascending: true }),
                  "id, user_id, name, cm_number, created_at, updated_at",
              )
            : Promise.resolve([]),
        userEmail
            ? selectAll(db, "tabular_reviews", (query) =>
                  query
                      .filter("shared_with", "cs", JSON.stringify([userEmail]))
                      .neq("user_id", userId)
                      .order("created_at", { ascending: true }),
                  "id, user_id, project_id, title, practice, created_at, updated_at",
              )
            : Promise.resolve([]),
        selectAll(db, "audit_events", (query) =>
            query
                .eq("user_id", userId)
                .order("created_at", { ascending: true }),
        ),
    ]);

    const projectIds = idsFrom(projects);
    const projectDocuments = await selectByIds(
        db,
        "documents",
        "project_id",
        projectIds,
    );
    const documents = [...standaloneDocuments, ...projectDocuments];
    const documentIds = idsFrom(documents);
    const reviewIds = idsFrom(tabularReviews);

    const [folders, versions, edits, tabularCells] = await Promise.all([
        selectByIds(db, "project_subfolders", "project_id", projectIds),
        selectByIds(db, "document_versions", "document_id", documentIds),
        selectByIds(db, "document_edits", "document_id", documentIds),
        selectByIds(db, "tabular_cells", "review_id", reviewIds),
    ]);

    return {
        exported_at: new Date().toISOString(),
        user: { id: userId, email: userEmail ?? null },
        profile,
        api_keys: apiKeys,
        router_models: routerModels,
        projects,
        project_subfolders: folders,
        documents,
        document_versions: versions,
        document_edits: edits,
        workflows,
        default_workflow_installations: defaultWorkflowInstallations,
        quick_actions: quickActions,
        workflow_open_source_submissions: workflowOpenSourceSubmissions,
        hidden_workflows: hiddenWorkflows,
        workflow_shares_by_user: workflowSharesByUser,
        workflow_shares_with_user: workflowSharesWithUser,
        chats: assistantChats,
        tabular_reviews: tabularReviews,
        tabular_cells: tabularCells,
        tabular_review_chats: tabularChats,
        shared_access: {
            projects: sharedProjects,
            tabular_reviews: sharedTabularReviews,
        },
        audit_events: auditEvents,
    };
}
