import { createHash } from "node:crypto";
import {
    checkProjectAccess,
    checkWorkflowAccess,
    ensureChatAccess,
    ensureDocAccess,
    ensureReviewAccess,
    type OrgRole,
} from "../../lib/access";
import { mapWithConcurrency } from "../../lib/concurrency";
import { sealManifest } from "../../lib/manifestSigning";
import { type Db } from "../../lib/supabase";
import {
    resolvePlaybookRoles,
    type PlaybookAccessRow,
} from "../playbooks/playbooks.service";
import { throwIfError, uniqueStrings } from "./user.shared";

const PAGE_SIZE = 1000;

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

export function userExportFilename(
    kind: "account" | "chats" | "tabular-reviews",
    userId: string,
    orgId: string | null = null,
) {
    const workspace = orgId ? `-org-${orgId.slice(0, 8)}` : "";
    return `mike-${kind}-export-${userId.slice(0, 8)}${workspace}-${nowStamp()}.json`;
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

/**
 * The workspace an export covers: an organization's id, or null for
 * Personal. Settings exports one workspace at a time; a row is in it as
 * public.workspace_matches decides, by its org_id.
 */
type ExportWorkspace = string | null;

function inWorkspace(query: any, orgId: ExportWorkspace, column = "org_id") {
    return orgId ? query.eq(column, orgId) : query.is(column, null);
}

function rowInWorkspace(row: Record<string, unknown>, orgId: ExportWorkspace) {
    return (typeof row.org_id === "string" ? row.org_id : null) === orgId;
}

function idsFrom(rows: Record<string, unknown>[], column = "id"): string[] {
    return uniqueStrings(
        rows.map((row) =>
            typeof row[column] === "string" ? (row[column] as string) : null,
        ),
    );
}

type ExportResourceRow = Record<string, unknown> & {
    id: string;
    user_id: string | null;
    project_id: string | null;
    org_id?: string | null;
    workflow_id?: string | null;
    archived_at?: string | null;
};

/**
 * Export jobs use the service-role client. Creator provenance only chooses
 * candidates; normal read permissions decide which content may leave the app.
 * Check at build time, since membership or sharing may change while queued.
 */
async function readableRows(
    rows: Record<string, unknown>[],
    authorize: (row: ExportResourceRow) => Promise<{ ok: boolean }>,
): Promise<Record<string, unknown>[]> {
    const allowed = await mapWithConcurrency(rows, 8, async (row) =>
        typeof row.id === "string" && !row.archived_at
            ? (await authorize(row as ExportResourceRow)).ok
            : false,
    );
    return rows.filter((_, index) => allowed[index]);
}

async function loadUserReviews(
    db: Db,
    userId: string,
    userEmail: string | null | undefined,
    orgId: ExportWorkspace,
) {
    const reviews = await selectAll(db, "tabular_reviews", (query) =>
        inWorkspace(query.eq("user_id", userId), orgId).order("created_at", {
            ascending: true,
        }),
    );
    return readableRows(reviews, (row) =>
        ensureReviewAccess(row, userId, userEmail, db),
    );
}

/**
 * One memory file: a project's, or a person's for one workspace. A person
 * has one per workspace, so the user scope names which (`orgId`, null for
 * Personal) — read unnarrowed, the first of them would stand in for all.
 */
async function loadMemoryExport(
    db: Db,
    scope: "user" | "project",
    ownerId: string,
    orgId: ExportWorkspace = null,
) {
    const ownerColumn = scope === "user" ? "user_id" : "project_id";
    const rows = await selectAll(
        db,
        "memory_files",
        (query) => {
            const owned = query.eq("scope", scope).eq(ownerColumn, ownerId);
            return scope === "user" ? inWorkspace(owned, orgId) : owned;
        },
        "id, enabled, epoch, revision, content, content_sha256, size_bytes, status, last_source, updated_by, created_at, updated_at",
    );
    const file = rows[0];
    if (!file) {
        return {
            // Missing state is legacy/corrupt and must never be reported as an
            // implicit opt-in. New owners receive an explicit row at creation.
            enabled: false,
            epoch: 0,
            revision: 0,
            status: "idle",
            created_at: null,
            updated_at: null,
            markdown: "",
            content_sha256: null,
            size_bytes: 0,
            source: null,
            updated_by: null,
        };
    }

    const markdown = typeof file.content === "string" ? file.content : "";
    const storedHash =
        typeof file.content_sha256 === "string" ? file.content_sha256 : null;
    if (storedHash) {
        const actualHash = createHash("sha256")
            .update(markdown, "utf8")
            .digest("hex");
        if (actualHash !== storedHash) {
            throw new Error("Memory export content checksum mismatch");
        }
    }

    return {
        enabled: file.enabled === true,
        epoch: Number(file.epoch),
        revision: Number(file.revision),
        status: String(file.status ?? "idle"),
        created_at:
            typeof file.created_at === "string" ? file.created_at : null,
        updated_at:
            typeof file.updated_at === "string" ? file.updated_at : null,
        markdown,
        content_sha256: storedHash,
        size_bytes: Number(file.size_bytes ?? 0),
        source: typeof file.last_source === "string" ? file.last_source : null,
        updated_by:
            typeof file.updated_by === "string" ? file.updated_by : null,
    };
}

async function loadUserChats(
    db: Db,
    userId: string,
    userEmail: string | null | undefined,
    orgId: ExportWorkspace,
) {
    const candidates = await selectAll(db, "chats", (query) =>
        inWorkspace(query.eq("user_id", userId), orgId).order("created_at", {
            ascending: true,
        }),
    );
    const chats = await readableRows(candidates, (row) =>
        ensureChatAccess(row, userId, userEmail, db),
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

async function loadUserTabularChats(
    db: Db,
    userId: string,
    userEmail: string | null | undefined,
    orgId: ExportWorkspace,
) {
    const candidates = await selectAll(db, "tabular_review_chats", (query) =>
        query.eq("user_id", userId).order("created_at", { ascending: true }),
    );
    // A review chat retains its creator after that person leaves the team.
    // Its parent review, not that creator id, controls access to the transcript.
    const reviews = await selectByIds(
        db,
        "tabular_reviews",
        "id",
        idsFrom(candidates, "review_id"),
    );
    // A review chat is in its review's workspace.
    const readableReviews = await readableRows(
        reviews.filter((review) => rowInWorkspace(review, orgId)),
        (row) => ensureReviewAccess(row, userId, userEmail, db),
    );
    const reviewIds = new Set(idsFrom(readableReviews));
    const chats = candidates.filter(
        (chat) => typeof chat.review_id === "string" && reviewIds.has(chat.review_id),
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

/**
 * The playbooks this user created, the reviews they ran, and their imports.
 *
 * Playbook access is decided by resolvePlaybookRoles, the same rule the
 * playbooks list uses: an organization's playbook needs current membership,
 * even for its creator. A run's rules snapshot (`content_json`) is the
 * playbook's policy, so a run leaves only while its playbook can still be
 * opened, whoever created that playbook. The supplementary documents' text
 * stays behind like document bytes do; their metadata is listed.
 */
async function loadUserPlaybooks(
    db: Db,
    userId: string,
    userEmail: string | null | undefined,
    orgMemberships: Record<string, unknown>[],
    orgId: ExportWorkspace,
) {
    const orgRoles = new Map<string, OrgRole>();
    for (const row of orgMemberships) {
        if (typeof row.org_id === "string" && typeof row.role === "string")
            orgRoles.set(row.org_id, row.role as OrgRole);
    }

    const [created, runCandidates, imports] = await Promise.all([
        selectAll(db, "playbooks", (query) =>
            query.eq("user_id", userId).order("created_at", { ascending: true }),
        ),
        selectAll(db, "playbook_runs", (query) =>
            query.eq("user_id", userId).order("started_at", { ascending: true }),
        ),
        selectAll(db, "playbook_imports", (query) =>
            query.eq("user_id", userId).order("started_at", { ascending: true }),
        ),
    ]);
    const createdIds = new Set(idsFrom(created));
    const runPlaybooks = await selectByIds(
        db,
        "playbooks",
        "id",
        idsFrom(runCandidates, "playbook_id").filter((id) => !createdIds.has(id)),
    );
    const roles = await resolvePlaybookRoles(
        db,
        [...created, ...runPlaybooks] as PlaybookAccessRow[],
        userId,
        userEmail,
        orgRoles,
    );
    // A run is in its playbook's workspace.
    const inScope = new Set(
        idsFrom(
            [...created, ...runPlaybooks].filter(
                (row) => roles.has(row.id as string) && rowInWorkspace(row, orgId),
            ),
        ),
    );
    const playbooks = created.filter((row) => inScope.has(row.id as string));
    const playbookIds = idsFrom(playbooks);
    const sources =
        playbookIds.length === 0
            ? []
            : await selectAll(
                  db,
                  "playbook_sources",
                  (query) =>
                      query
                          .in("playbook_id", playbookIds)
                          .order("created_at", { ascending: true }),
                  "id, playbook_id, filename, file_type, size_bytes, text_length, created_at",
              );

    return {
        playbooks,
        playbook_sources: sources,
        playbook_runs: runCandidates.filter(
            (row) =>
                typeof row.playbook_id === "string" &&
                inScope.has(row.playbook_id),
        ),
        // Import records are metadata (file name, stage, error); one made in
        // an organization the user has left stays with that organization.
        playbook_imports: imports.filter(
            (row) =>
                rowInWorkspace(row, orgId) &&
                (typeof row.org_id !== "string" || orgRoles.has(row.org_id)),
        ),
    };
}

async function loadApiKeyStatus(db: Db, userId: string) {
    const rows = await selectAll(db, "user_api_keys", (query) =>
        query
            .eq("user_id", userId)
            .order("provider", { ascending: true }),
        // Never the key material (encrypted_key, iv, auth_tag): only what
        // the user can already see in Settings.
        "provider, settings, enabled, created_at, updated_at",
    );
    return rows.map((row) => ({
        provider: row.provider,
        has_key: true,
        // A disabled provider keeps its key; enabled defaults to true.
        enabled: row.enabled !== false,
        // The non-secret region/endpoint/location/base URL saved with it.
        settings: row.settings ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }));
}

/** What the export says it covers: Personal, or the organization's id. */
function workspaceLabel(orgId: ExportWorkspace) {
    return orgId ? { organization_id: orgId } : { personal: true };
}

export async function buildUserChatsExport(
    db: Db,
    userId: string,
    userEmail: string | null | undefined,
    orgId: ExportWorkspace,
) {
    const [assistant, wordAddin, tabular] = await Promise.all([
        loadUserChats(db, userId, userEmail, orgId),
        // The Word add-in works in Personal only.
        orgId
            ? Promise.resolve({ documents: [], chats: [], messages: [] })
            : loadUserWordChats(db, userId),
        loadUserTabularChats(db, userId, userEmail, orgId),
    ]);

    return {
        exported_at: new Date().toISOString(),
        user: { id: userId, email: userEmail ?? null },
        workspace: workspaceLabel(orgId),
        assistant_chats: assistant,
        word_addin_chats: wordAddin,
        tabular_review_chats: tabular,
    };
}

export async function buildUserTabularReviewsExport(
    db: Db,
    userId: string,
    userEmail: string | null | undefined,
    orgId: ExportWorkspace,
) {
    const tabularReviews = await loadUserReviews(db, userId, userEmail, orgId);
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
        workspace: workspaceLabel(orgId),
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

    const memory = await loadMemoryExport(db, "project", projectId);

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
        memory,
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

/**
 * The account JSON for one workspace. Personal's carries the account itself
 * as well — profile, keys, preferences, the organizations the person belongs
 * to — and Personal's content; an organization's carries only the person's
 * work in it.
 */
export async function buildUserAccountExport(
    db: Db,
    userId: string,
    userEmail: string | null | undefined,
    orgId: ExportWorkspace,
) {
    // Account-level data has no workspace; it leaves with Personal's export.
    const personalOnly = <T>(load: () => Promise<T>, empty: T): Promise<T> =>
        orgId ? Promise.resolve(empty) : load();
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
        appMemory,
    ] = await Promise.all([
        personalOnly(
            () =>
                selectAll(db, "user_profiles", (query) =>
                    query.eq("user_id", userId),
                ),
            [],
        ),
        personalOnly(() => loadApiKeyStatus(db, userId), null),
        personalOnly(
            () =>
                selectAll(db, "user_router_models", (query) =>
                    query
                        .eq("user_id", userId)
                        .order("router", { ascending: true })
                        .order("sort_order", { ascending: true }),
                ),
            [],
        ),
        selectAll(db, "projects", (query) =>
            inWorkspace(query.eq("user_id", userId), orgId).order("created_at", {
                ascending: true,
            }),
        ).then((rows) =>
            readableRows(rows, (row) =>
                checkProjectAccess(row.id, userId, userEmail, db),
            ),
        ),
        selectAll(db, "documents", (query) =>
            inWorkspace(query.eq("user_id", userId).is("project_id", null), orgId)
                .order("created_at", { ascending: true }),
        ),
        selectAll(db, "workflows", (query) =>
            inWorkspace(query.eq("user_id", userId), orgId).order("created_at", {
                ascending: true,
            }),
        ).then((rows) =>
            readableRows(rows, (row) =>
                checkWorkflowAccess(row.id, userId, userEmail, db),
            ),
        ),
        personalOnly(
            () =>
                selectAll(db, "default_workflow_installations", (query) =>
                    query
                        .eq("user_id", userId)
                        .order("installed_at", { ascending: true }),
                ),
            [],
        ),
        personalOnly(
            () =>
                selectAll(db, "quick_actions", (query) =>
                    query.eq("user_id", userId).order("sort_order", { ascending: true }),
                ),
            [],
        ),
        personalOnly(
            () =>
                selectAll(db, "workflow_open_source_submissions", (query) =>
                    query
                        .eq("submitted_by_user_id", userId)
                        .order("submitted_at", { ascending: true }),
                ),
            [],
        ),
        personalOnly(
            () =>
                selectAll(db, "hidden_workflows", (query) =>
                    query.eq("user_id", userId).order("created_at", { ascending: true }),
                ),
            [],
        ),
        // Narrowed to the exported workflows below.
        selectAll(db, "workflow_shares", (query) =>
            query
                .eq("shared_by_user_id", userId)
                .order("created_at", { ascending: true }),
        ),
        userEmail
            ? personalOnly(
                  () =>
                      selectAll(db, "workflow_shares", (query) =>
                          query
                              .eq("shared_with_email", userEmail)
                              .order("created_at", { ascending: true }),
                      ),
                  [],
              )
            : Promise.resolve([]),
        loadUserChats(db, userId, userEmail, orgId),
        loadUserTabularChats(db, userId, userEmail, orgId),
        loadUserReviews(db, userId, userEmail, orgId),
        userEmail
            ? (async () => {
                  // Grants are candidates too: stale grants cannot override
                  // current organization membership or resource permissions.
                  const grantRows = await selectAll(
                      db,
                      "project_access_grants",
                      (query) =>
                          query.eq(
                              "email",
                              userEmail.trim().toLowerCase(),
                          ),
                      "project_id",
                  );
                  const projectIds = [
                      ...new Set(
                          grantRows
                              .map((row) => row.project_id as string | null)
                              .filter((id): id is string => !!id),
                      ),
                  ];
                  if (projectIds.length === 0) return [];
                  return selectAll(db, "projects", (query) =>
                      inWorkspace(
                          query.in("id", projectIds).neq("user_id", userId),
                          orgId,
                      ).order("created_at", { ascending: true }),
                      "id, user_id, org_id, name, cm_number, created_at, updated_at",
                  ).then(async (rows) => {
                      const readable = await readableRows(rows, (row) =>
                          checkProjectAccess(row.id, userId, userEmail, db),
                      );
                      return readable.map(({ org_id: _org, ...row }) => row);
                  });
              })()
            : Promise.resolve([]),
        userEmail
            ? (async () => {
                  const grantRows = await selectAll(
                      db,
                      "tabular_review_access_grants",
                      (query) =>
                          query.eq(
                              "email",
                              userEmail.trim().toLowerCase(),
                          ),
                      "tabular_review_id",
                  );
                  const reviewIds = [
                      ...new Set(
                          grantRows
                              .map(
                                  (row) =>
                                      row.tabular_review_id as string | null,
                              )
                              .filter((id): id is string => !!id),
                      ),
                  ];
                  if (reviewIds.length === 0) return [];
                  return selectAll(db, "tabular_reviews", (query) =>
                      query
                          .in("id", reviewIds)
                          .neq("user_id", userId)
                          .order("created_at", { ascending: true }),
                      "id, user_id, project_id, org_id, archived_at, title, practice, created_at, updated_at",
                  ).then(async (rows) => {
                      const readable = await readableRows(
                          rows.filter((row) => rowInWorkspace(row, orgId)),
                          (row) => ensureReviewAccess(row, userId, userEmail, db),
                      );
                      return readable.map(
                          ({ org_id: _org, archived_at: _archive, ...row }) => row,
                      );
                  });
              })()
            : Promise.resolve([]),
        selectAll(db, "audit_events", (query) =>
            inWorkspace(query.eq("user_id", userId), orgId).order("created_at", {
                ascending: true,
            }),
        ),
        loadMemoryExport(db, "user", userId, orgId),
    ]);

    // Organization membership + the orgs the user belongs to and the
    // invitations addressed to them, for a complete GDPR-style export of
    // their multi-tenant footprint.
    const orgMemberships = await selectAll(db, "org_members", (query) =>
        query.eq("user_id", userId).order("created_at", { ascending: true }),
    );
    const orgIds = idsFrom(orgMemberships, "org_id");
    const [organizations, orgInvitations] = await Promise.all([
        personalOnly(() => selectByIds(db, "organizations", "id", orgIds), []),
        userEmail
            ? personalOnly(
                  () =>
                      selectAll(db, "org_invitations", (query) =>
                          query
                              .eq("email", userEmail.trim().toLowerCase())
                              .order("created_at", { ascending: true }),
                      ),
                  [],
              )
            : Promise.resolve([]),
    ]);

    const playbooks = await loadUserPlaybooks(
        db,
        userId,
        userEmail,
        orgMemberships,
        orgId,
    );
    const exportedWorkflowIds = new Set(idsFrom(workflows));

    const projectIds = idsFrom(projects);
    const projectDocuments = await selectByIds(
        db,
        "documents",
        "project_id",
        projectIds,
    );
    const documents = await readableRows(
        [...standaloneDocuments, ...projectDocuments],
        (row) => ensureDocAccess(row, userId, userEmail, db),
    );
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
        workspace: workspaceLabel(orgId),
        ...(orgId
            ? {}
            : {
                  profile,
                  api_keys: apiKeys,
                  router_models: routerModels,
                  organizations,
                  org_members: orgMemberships,
                  org_invitations: orgInvitations,
                  default_workflow_installations: defaultWorkflowInstallations,
                  quick_actions: quickActions,
                  workflow_open_source_submissions:
                      workflowOpenSourceSubmissions,
                  hidden_workflows: hiddenWorkflows,
                  workflow_shares_with_user: workflowSharesWithUser,
              }),
        projects,
        project_subfolders: folders,
        documents,
        document_versions: versions,
        document_edits: edits,
        workflows,
        workflow_shares_by_user: workflowSharesByUser.filter(
            (row) =>
                typeof row.workflow_id === "string" &&
                exportedWorkflowIds.has(row.workflow_id),
        ),
        chats: assistantChats,
        tabular_reviews: tabularReviews,
        tabular_cells: tabularCells,
        tabular_review_chats: tabularChats,
        ...playbooks,
        shared_access: {
            projects: sharedProjects,
            tabular_reviews: sharedTabularReviews,
        },
        memory: appMemory,
        audit_events: auditEvents,
    };
}
