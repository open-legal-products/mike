import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import { sendInternalError } from "../lib/httpError";
import { downloadFile } from "../lib/storage";
import { attachActiveVersionPaths } from "../lib/documentVersions";
import { docxToPdf, normalizeDocxZipPaths } from "../lib/convert";
import {
    isPresentationDocumentType,
    isSpreadsheetDocumentType,
    isWordDocumentType,
} from "../lib/documentTypes";
import { extractPresentationText } from "../lib/officeText";
import { spreadsheetToLLMText } from "../lib/spreadsheet";
import {
    AssistantStreamError,
    ASSISTANT_ERROR_MESSAGE,
    buildCancelledAssistantMessage,
    isAbortError,
    runLLMStream,
    stripTransientAssistantEvents,
    TABULAR_TOOLS,
    type ChatMessage,
    type TabularCellStore,
} from "../lib/chat";
import {
    completeText,
    providerForModel,
    streamChatWithTools,
    type Provider,
    type UserApiKeys,
    missingCommitteeApiKeyModels,
} from "../lib/llm";
import {
    apiKeyForConfiguredModel,
    getCommitteeModel,
    getConfiguredModel,
} from "../lib/llm/registry";
import type { CommitteeModel } from "../lib/llm/types";
import { getUserModelSettings } from "../lib/userSettings";
import {
    checkProjectAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
} from "../lib/access";
import {
    findMissingUserEmails,
    loadProfileUsersByEmail,
} from "../lib/userLookup";
import {
    buildTabularReviewIdsOverviewRpcArgs,
    buildTabularReviewsOverviewRpcArgs,
    parseTabularReviewScope,
} from "../lib/tabularReviewsOverview";
import { parsePaginationQuery } from "../lib/pagination";
import { normalizeSearchTerm } from "../lib/search";
import { parseTabularReviewSort } from "../lib/sort";

function formatPromptSuffix(format?: string, tags?: string[]): string {
    switch (format) {
        case "bulleted_list":
            return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
        case "number":
            return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
        case "percentage":
            return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
        case "monetary_amount":
            return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
        case "currency":
            return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
        case "yes_no":
            return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[document:SOURCE_DOCUMENT_ID||page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
        case "date":
            return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[document:SOURCE_DOCUMENT_ID||page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
        case "tag":
            return tags?.length
                ? ` The \"summary\" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((t) => `[[${t}]]`).join(", ")}. No other text. The \"reasoning\" field MUST include an inline citation [[document:SOURCE_DOCUMENT_ID||page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
                : "";
        default:
            return "";
    }
}

export const tabularRouter = Router();
const TABULAR_GENERATION_CONCURRENCY = 3;
const TABULAR_GENERATION_LEASE_SECONDS = 300;
const TABULAR_GENERATION_HEARTBEAT_MS = 60_000;

type DocumentGrouping = "document" | "folder";
type ReviewRow = {
    id: string;
    review_id: string;
    label: string;
    row_type: "document" | "folder";
    folder_id: string | null;
    library_folder_id: string | null;
    document_id: string | null;
    sort_index: number;
    source_document_ids?: string[];
};
type SourceDocument = {
    id: string;
    filename: string;
    file_type: string | null;
    current_version_id?: string | null;
    project_id?: string | null;
    folder_id?: string | null;
    library_folder_id?: string | null;
};
type SupabaseDb = ReturnType<typeof createServerSupabase>;

function isReviewGenerationRunning(review: Record<string, unknown>): boolean {
    if (!review.active_generation_id || !review.generation_lease_expires_at) {
        return false;
    }
    const leaseExpiresAt = Date.parse(
        String(review.generation_lease_expires_at),
    );
    return Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now();
}

function normalizeGrouping(value: unknown): DocumentGrouping {
    return value === "folder" ? "folder" : "document";
}

async function fetchSourceDocuments(
    db: SupabaseDb,
    documentIds: string[],
): Promise<SourceDocument[]> {
    if (documentIds.length === 0) return [];
    const { data, error } = await db
        .from("documents")
        .select(
            "id, current_version_id, project_id, folder_id, library_folder_id",
        )
        .in("id", documentIds);
    if (error) throw new Error(error.message);
    const docs = (data ?? []) as (Omit<
        SourceDocument,
        "filename" | "file_type"
    > & {
        filename?: string | null;
        file_type?: string | null;
    })[];
    await attachActiveVersionPaths(db, docs);
    const position = new Map(documentIds.map((id, index) => [id, index]));
    return docs
        .map((doc) => ({
            ...doc,
            filename: doc.filename?.trim() || "Untitled document",
            file_type: doc.file_type ?? null,
        }))
        .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
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
    db: SupabaseDb,
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

async function createRowsForReview(
    db: SupabaseDb,
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

async function rebuildRowsForReview(
    db: SupabaseDb,
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

async function syncCellsForReviewRows(
    db: SupabaseDb,
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

async function loadReviewRows(
    db: SupabaseDb,
    reviewId: string,
): Promise<ReviewRow[]> {
    const { data, error } = await db
        .from("tabular_review_rows")
        .select("*")
        .eq("review_id", reviewId)
        .order("sort_index", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ReviewRow[];
    if (!rows.length) return rows;
    const { data: sources, error: sourceError } = await db
        .from("tabular_review_row_sources")
        .select("row_id, document_id")
        .in(
            "row_id",
            rows.map((row) => row.id),
        )
        .order("sort_index", { ascending: true });
    if (sourceError) throw new Error(sourceError.message);
    const byRow = new Map<string, string[]>();
    for (const source of sources ?? []) {
        byRow.set(source.row_id, [
            ...(byRow.get(source.row_id) ?? []),
            source.document_id,
        ]);
    }
    return rows.map((row) => ({
        ...row,
        source_document_ids:
            byRow.get(row.id) ?? (row.document_id ? [row.document_id] : []),
    }));
}

async function loadRowDocumentText(
    db: SupabaseDb,
    row: ReviewRow,
): Promise<string> {
    const sourceIds =
        row.source_document_ids ?? (row.document_id ? [row.document_id] : []);
    const docs = await fetchSourceDocuments(db, sourceIds);
    const sections: string[] = [];
    for (const doc of docs) {
        const storagePath = (doc as SourceDocument & { storage_path?: string })
            .storage_path;
        let markdown = "";
        if (storagePath) {
            const buf = await downloadFile(storagePath);
            if (buf) {
                try {
                    markdown = await extractDocumentMarkdown(
                        buf,
                        doc.file_type,
                    );
                } catch (error) {
                    console.error(
                        `[tabular] extraction error doc=${doc.id}`,
                        error,
                    );
                }
            }
        }
        sections.push(
            `## Source document: ${doc.filename}\nSource document ID: ${doc.id}\n\n${markdown}`,
        );
    }
    return sections.join("\n\n---\n\n");
}

function providerLabel(provider: Provider): string {
    if (provider === "claude") return "Anthropic";
    if (provider === "openai") return "OpenAI";
    if (provider === "openrouter") return "OpenRouter";
    if (provider === "vercel") return "Vercel AI Gateway";
    if (provider === "opencode-go") return "OpenCode Go";
    if (provider === "ollama") return "Local (Ollama)";
    if (provider === "openai-compatible") return "Configured endpoint";
    return "Gemini";
}

function missingModelApiKey(
    model: string,
    apiKeys: UserApiKeys,
    committees: CommitteeModel[] = [],
) {
    // A committee runs only if every member and its chair can run.
    const committee = getCommitteeModel(model, committees);
    if (committee) {
        const missing = missingCommitteeApiKeyModels(
            model,
            apiKeys,
            committees,
        );
        if (!missing.length) return null;
        return {
            provider: "committee" as const,
            model,
            detail: `Committee ${committee.label || committee.id} cannot run because these models are unavailable or missing API keys: ${missing.join(", ")}. Add the missing API keys or select a different tabular review model.`,
        };
    }
    const provider = providerForModel(model, committees);
    if (provider === "ollama") return null; // local, no key
    if (provider === "openai-compatible") {
        const configured = getConfiguredModel(model);
        // A self-hosted endpoint authenticates however the deployment set it
        // up, including not at all, so only cloud entries can be short a key.
        if (!configured || configured.location === "local") return null;
        if (apiKeyForConfiguredModel(configured, apiKeys)) return null;
        return {
            provider,
            model,
            detail: `An API key is required to use ${configured.label || model}. Add an API key or select a different tabular review model.`,
        };
    }
    if (apiKeys[provider]?.trim()) return null;
    return {
        provider,
        model,
        detail: `${providerLabel(provider)} API key is required to use ${model}. Add an API key or select a different tabular review model.`,
    };
}

// GET /tabular-review
tabularRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;

    const rpcArgs = buildTabularReviewsOverviewRpcArgs({
        userId,
        userEmail,
        projectIdFilter,
        scope: parseTabularReviewScope(req.query.scope),
        pagination: parsePaginationQuery(req.query as Record<string, unknown>),
        searchTerm: normalizeSearchTerm(req.query.search),
        sort: parseTabularReviewSort(req.query as Record<string, unknown>),
    });

    const { data, error } = await db.rpc(
        "get_tabular_reviews_overview",
        rpcArgs,
    );
    if (error) return void sendInternalError(res, error);

    res.json(data ?? []);
});

// GET /tabular-review/ids (must come before /:reviewId routes)
// Lightweight id + owner list for every review matching the current
// filters — backs "select all matching" bulk actions so the client doesn't
// have to page through full review payloads just to collect checkboxes.
//
// PostgREST enforces its own row cap on every RPC response (db-max-rows),
// independent of anything this route asks for, and truncates silently
// (206 + a shorter array, no error) rather than failing. So this pages
// through the RPC itself — server-side, same-datacenter round trips — until
// a page comes back empty, rather than trusting one call to return
// everything.
const TABULAR_REVIEW_IDS_PAGE_SIZE = 1000;
const TABULAR_REVIEW_IDS_MAX_PAGES = 200; // guards a runaway loop, not a product limit

tabularRouter.get("/ids", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const projectIdFilter =
        typeof req.query.project_id === "string" && req.query.project_id
            ? (req.query.project_id as string)
            : null;
    const searchTerm = normalizeSearchTerm(req.query.search);
    const scope = parseTabularReviewScope(req.query.scope);

    const ids: { id: string; user_id: string }[] = [];
    let offset = 0;
    for (let page = 0; page < TABULAR_REVIEW_IDS_MAX_PAGES; page++) {
        const rpcArgs = buildTabularReviewIdsOverviewRpcArgs({
            userId,
            userEmail,
            projectIdFilter,
            scope,
            searchTerm,
            pagination: { limit: TABULAR_REVIEW_IDS_PAGE_SIZE, offset },
        });
        const { data, error } = await db.rpc(
            "get_tabular_review_ids_overview",
            rpcArgs,
        );
        if (error) return void sendInternalError(res, error);

        const rows = (data ?? []) as { id: string; user_id: string }[];
        if (rows.length === 0) break;
        ids.push(...rows);
        offset += rows.length;
    }

    res.json(ids);
});

// POST /tabular-review
tabularRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const {
        title,
        document_ids,
        columns_config,
        workflow_id,
        project_id,
        document_grouping,
    } = req.body as {
        title?: string;
        document_ids: string[];
        columns_config: { index: number; name: string; prompt: string }[];
        workflow_id?: string;
        project_id?: string;
        document_grouping?: DocumentGrouping;
    };

    const db = createServerSupabase();
    if (project_id) {
        const access = await checkProjectAccess(
            project_id,
            userId,
            userEmail,
            db,
        );
        if (!access.ok)
            return void res.status(404).json({ detail: "Project not found" });
    }
    const allowedDocumentIds = Array.isArray(document_ids)
        ? await filterAccessibleDocumentIds(document_ids, userId, userEmail, db)
        : [];
    const grouping = normalizeGrouping(document_grouping);
    const { data: review, error } = await db
        .from("tabular_reviews")
        .insert({
            user_id: userId,
            title: title ?? null,
            columns_config,
            document_ids: allowedDocumentIds,
            project_id: project_id ?? null,
            workflow_id: workflow_id ?? null,
            document_grouping: grouping,
        })
        .select("*")
        .single();
    if (error || !review)
        return void sendInternalError(
            res,
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
    } catch (error) {
        await db.from("tabular_reviews").delete().eq("id", review.id);
        return void res.status(500).json({
            detail:
                error instanceof Error
                    ? error.message
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
    });
    res.status(201).json(review);
});

// POST /tabular-review/prompt (must come before /:reviewId routes)
tabularRouter.post("/prompt", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const title =
        typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const format: string =
        typeof req.body.format === "string" ? req.body.format : "text";
    const documentName: string =
        typeof req.body.documentName === "string"
            ? req.body.documentName.trim()
            : "";
    const tags: string[] = Array.isArray(req.body.tags)
        ? req.body.tags.filter((t: unknown) => typeof t === "string")
        : [];

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        const { title_model, api_keys } = await getUserModelSettings(userId);
        const raw = await completeText({
            model: title_model,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            res.json({ prompt: parsed.prompt.trim(), source: "llm" });
        } else {
            res.status(502).json({ detail: "LLM returned an empty prompt" });
        }
    } catch {
        res.status(502).json({ detail: "Failed to generate prompt from LLM" });
    }
});

// GET /tabular-review/:reviewId
tabularRouter.get("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const { data: cells, error: cellsError } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    if (cellsError)
        return void sendInternalError(res, cellsError);
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

    res.json({
        review: {
            ...clientReview,
            is_owner: access.isOwner,
            is_running: isReviewGenerationRunning(review),
        },
        cells: (cells ?? []).map((cell) => ({
            ...cell,
            content: parseCellContent(cell.content),
        })),
        rows,
        documents: docs,
    });
});

// GET /tabular-review/:reviewId/people
// Owner email + display_name plus member display_names — the analog of
// /projects/:id/people. Used by the standalone TR detail page's People
// modal so the roster can show display_names alongside emails.
tabularRouter.get("/:reviewId/people", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id, shared_with")
        .eq("id", reviewId)
        .single();
    if (!review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const sharedWith: string[] = (
        Array.isArray(review.shared_with)
            ? (review.shared_with as string[])
            : []
    ).map((e) => (e ?? "").toLowerCase());

    // Use the mirrored profile email so sharing checks do not scan auth.users.
    const { userByEmail, userById } = await loadProfileUsersByEmail(db);

    const ownerInfo = userById.get(review.user_id as string);
    res.json({
        owner: {
            user_id: review.user_id,
            email: ownerInfo?.email ?? null,
            display_name: ownerInfo?.display_name ?? null,
        },
        members: sharedWith.map((email) => {
            const u = userByEmail.get(email);
            const display_name = u?.display_name ?? null;
            return { email, display_name };
        }),
    });
});

// PATCH /tabular-review/:reviewId
tabularRouter.patch("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const updates: Record<string, unknown> = {};
    if (req.body.title != null) updates.title = req.body.title;
    const projectIdUpdateProvided = req.body.project_id !== undefined;
    const projectIdUpdate =
        req.body.project_id === null
            ? null
            : typeof req.body.project_id === "string" &&
                req.body.project_id.trim()
              ? req.body.project_id.trim()
              : undefined;
    if (projectIdUpdateProvided && projectIdUpdate === undefined) {
        return void res.status(400).json({
            detail: "project_id must be a non-empty string or null",
        });
    }
    // shared_with edits are owner-only — gated below after we know who's
    // making the call. Normalize lowercase + dedupe + drop empties.
    let sharedWithUpdate: string[] | undefined;
    if (Array.isArray(req.body.shared_with)) {
        const normalizedUserEmail = userEmail?.trim().toLowerCase();
        const seen = new Set<string>();
        const cleaned: string[] = [];
        for (const raw of req.body.shared_with) {
            if (typeof raw !== "string") continue;
            const e = raw.trim().toLowerCase();
            if (!e || seen.has(e)) continue;
            if (normalizedUserEmail && e === normalizedUserEmail) {
                return void res.status(400).json({
                    detail: "You cannot share a tabular review with yourself.",
                });
            }
            seen.add(e);
            cleaned.push(e);
        }
        sharedWithUpdate = cleaned;
    }
    updates.updated_at = new Date().toISOString();

    const db = createServerSupabase();
    const { data: existingReview, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !existingReview)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(
        existingReview,
        userId,
        userEmail,
        db,
    );
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (
        (req.body.title != null ||
            req.body.document_ids != null ||
            req.body.document_grouping != null) &&
        !access.isOwner
    ) {
        return void res.status(403).json({
            detail: "Only the review owner can change review settings",
        });
    }
    if (req.body.columns_config != null) {
        if (!access.isOwner) {
            return void res.status(403).json({
                detail: "Only the review owner can change columns",
            });
        }
        updates.columns_config = req.body.columns_config;
    }
    if (req.body.document_grouping != null) {
        if (
            req.body.document_grouping !== "document" &&
            req.body.document_grouping !== "folder"
        ) {
            return void res.status(400).json({
                detail: "document_grouping must be document or folder",
            });
        }
        updates.document_grouping = req.body.document_grouping;
    }
    if (Array.isArray(req.body.document_ids)) {
        updates.document_ids = await filterAccessibleDocumentIds(
            req.body.document_ids,
            userId,
            userEmail,
            db,
        );
    }
    if (sharedWithUpdate !== undefined) {
        if (!access.isOwner)
            return void res
                .status(403)
                .json({ detail: "Only the review owner can change sharing" });
        const missingSharedUsers = await findMissingUserEmails(
            db,
            sharedWithUpdate,
        );
        if (missingSharedUsers.length > 0) {
            return void res.status(400).json({
                detail: `${missingSharedUsers[0]} does not belong to a Mike user.`,
            });
        }
        updates.shared_with = sharedWithUpdate;
    }
    if (projectIdUpdateProvided) {
        if (!access.isOwner) {
            return void res.status(403).json({
                detail: "Only the review owner can move a review",
            });
        }
        if (projectIdUpdate) {
            const projectAccess = await checkProjectAccess(
                projectIdUpdate,
                userId,
                userEmail,
                db,
            );
            if (!projectAccess.ok) {
                return void res
                    .status(404)
                    .json({ detail: "Target project not found" });
            }
        }
        updates.project_id = projectIdUpdate;
    }

    const { data: updatedReview, error: updateError } = await db
        .from("tabular_reviews")
        .update(updates)
        .eq("id", reviewId)
        .select("*")
        .single();
    if (updateError || !updatedReview)
        return void sendInternalError(
            res,
            updateError ?? new Error("Review update returned no data"),
        );

    const rowShapeChanged =
        Array.isArray(req.body.document_ids) ||
        req.body.document_grouping != null ||
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
        } else if (Array.isArray(req.body.columns_config)) {
            await syncCellsForReviewRows(db, reviewId, activeColumns);
        }
    } catch (error) {
        return void res.status(500).json({
            detail:
                error instanceof Error
                    ? error.message
                    : "Failed to synchronize review rows",
        });
    }

    res.json(updatedReview);
});

// DELETE /tabular-review/:reviewId
tabularRouter.delete("/:reviewId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
        .from("tabular_reviews")
        .delete()
        .eq("id", reviewId)
        .eq("user_id", userId);
    if (error) return void sendInternalError(res, error);
    res.status(204).send();
});

// POST /tabular-review/:reviewId/clear-cells
// Reset cells to an empty/pending state for the given row_ids. Does not
// delete the rows — it blanks `content` and sets `status` back to "pending".
tabularRouter.post("/:reviewId/clear-cells", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const { row_ids } = req.body as { row_ids?: string[] };

    if (!Array.isArray(row_ids) || row_ids.length === 0)
        return void res.status(400).json({ detail: "row_ids is required" });

    const db = createServerSupabase();
    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select(
            "id, user_id, project_id, updated_at, active_generation_id, generation_lease_expires_at",
        )
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });
    if (isReviewGenerationRunning(review)) {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is currently running.",
        });
    }

    const mutationId = randomUUID();
    const { data: startResult, error: startError } = await db.rpc(
        "begin_tabular_review_generation",
        {
            target_review_id: reviewId,
            expected_updated_at: review.updated_at,
            target_generation_id: mutationId,
            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
        },
    );
    if (startError) return void sendInternalError(res, startError);
    if (startResult === "running") {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is currently running.",
        });
    }
    if (startResult === "stale") {
        return void res.status(409).json({
            code: "review_stale",
            detail: "A newer version of this tabular review is available.",
        });
    }
    if (startResult !== "started") {
        return void res.status(startResult === "not_found" ? 404 : 500).json({
            detail:
                startResult === "not_found"
                    ? "Review not found"
                    : "Failed to clear tabular review cells",
        });
    }

    try {
        const { error } = await db
            .from("tabular_cells")
            .update({
                content: null,
                status: "pending",
                generation_id: null,
            })
            .eq("review_id", reviewId)
            .in("row_id", row_ids);
        if (error) return void sendInternalError(res, error);
        res.status(204).send();
    } finally {
        const { error } = await db.rpc("finish_tabular_review_generation", {
            target_review_id: reviewId,
            target_generation_id: mutationId,
        });
        if (error) {
            console.error(
                "[tabular/clear-cells] failed to release generation lease",
                error,
            );
        }
    }
});

// POST /tabular-review/:reviewId/regenerate-cell
tabularRouter.post(
    "/:reviewId/regenerate-cell",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId } = req.params;
        const { row_id, column_index } = req.body as {
            row_id?: string;
            column_index: number;
        };

        if (!row_id || column_index == null)
            return void res
                .status(400)
                .json({ detail: "row_id and column_index are required" });

        const db = createServerSupabase();
        const { data: review, error: reviewError } = await db
            .from("tabular_reviews")
            .select("*")
            .eq("id", reviewId)
            .single();
        if (reviewError || !review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });
        if (isReviewGenerationRunning(review)) {
            return void res.status(409).json({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
        }

        const column = (
            review.columns_config as {
                index: number;
                name: string;
                prompt: string;
                format?: string;
                tags?: string[];
            }[]
        ).find((c) => c.index === column_index);
        if (!column)
            return void res.status(400).json({ detail: "Column not found" });

        const rows = await loadReviewRows(db, reviewId);
        const row = rows.find((candidate) => candidate.id === row_id);
        if (!row)
            return void res
                .status(404)
                .json({ detail: "Review row not found" });
        const sourceIds = row.source_document_ids ?? [];
        const allowedSourceIds = await filterAccessibleDocumentIds(
            sourceIds,
            userId,
            userEmail,
            db,
        );
        if (allowedSourceIds.length !== sourceIds.length)
            return void res
                .status(404)
                .json({ detail: "Review row not found" });

        const { tabular_model, api_keys, committees } = await getUserModelSettings(
            userId,
            db,
        );
        const missingKey = missingModelApiKey(
            tabular_model,
            api_keys,
            committees,
        );
        if (missingKey) {
            return void res.status(422).json({
                code: "missing_api_key",
                ...missingKey,
            });
        }

        const generationId = randomUUID();
        const { data: startResult, error: startError } = await db.rpc(
            "begin_tabular_review_generation",
            {
                target_review_id: reviewId,
                expected_updated_at: review.updated_at,
                target_generation_id: generationId,
                lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
            },
        );
        if (startError) return void sendInternalError(res, startError);
        if (startResult === "running") {
            return void res.status(409).json({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
        }
        if (startResult === "stale") {
            return void res.status(409).json({
                code: "review_stale",
                detail: "A newer version of this tabular review is available.",
            });
        }
        if (startResult !== "started") {
            return void res
                .status(startResult === "not_found" ? 404 : 500)
                .json({
                    detail:
                        startResult === "not_found"
                            ? "Review not found"
                            : "Failed to regenerate tabular review cell",
                });
        }

        let renewingLease = false;
        const leaseHeartbeat = setInterval(() => {
            if (renewingLease) return;
            renewingLease = true;
            void (async () => {
                try {
                    const { data, error } = await db.rpc(
                        "renew_tabular_review_generation",
                        {
                            target_review_id: reviewId,
                            target_generation_id: generationId,
                            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
                        },
                    );
                    if (error || data !== true) {
                        console.error(
                            "[tabular/regenerate-cell] failed to renew generation lease",
                            error ?? "Lease is no longer active",
                        );
                    }
                } catch (error) {
                    console.error(
                        "[tabular/regenerate-cell] failed to renew generation lease",
                        error,
                    );
                } finally {
                    renewingLease = false;
                }
            })();
        }, TABULAR_GENERATION_HEARTBEAT_MS);

        try {
            const { error: generatingError } = await db
                .from("tabular_cells")
                .update({
                    status: "generating",
                    content: null,
                    generation_id: generationId,
                })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index);
            if (generatingError) {
                return void sendInternalError(res, generatingError);
            }

            const markdown = await loadRowDocumentText(db, row);
            const result = await queryTabularCell(
                tabular_model,
                row.label,
                markdown,
                column.prompt,
                column.format,
                column.tags,
                api_keys,
            );

            if (!result) {
                await db
                    .from("tabular_cells")
                    .update({ status: "error", generation_id: null })
                    .eq("review_id", reviewId)
                    .eq("row_id", row.id)
                    .eq("column_index", column_index)
                    .eq("generation_id", generationId);
                return void res
                    .status(500)
                    .json({ detail: "Generation failed" });
            }

            const { error: completedError } = await db
                .from("tabular_cells")
                .update({
                    content: JSON.stringify(result),
                    status: "done",
                    generation_id: null,
                })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index)
                .eq("generation_id", generationId);
            if (completedError) {
                return void sendInternalError(res, completedError);
            }

            res.json(result);
        } catch (error) {
            await db
                .from("tabular_cells")
                .update({ status: "error", generation_id: null })
                .eq("review_id", reviewId)
                .eq("row_id", row.id)
                .eq("column_index", column_index)
                .eq("generation_id", generationId);
            console.error(
                "[tabular/regenerate-cell] generation failed",
                error,
            );
            if (!res.headersSent) {
                res.status(500).json({ detail: "Generation failed" });
            }
        } finally {
            clearInterval(leaseHeartbeat);
            const { error } = await db.rpc(
                "finish_tabular_review_generation",
                {
                    target_review_id: reviewId,
                    target_generation_id: generationId,
                },
            );
            if (error) {
                console.error(
                    "[tabular/regenerate-cell] failed to release generation lease",
                    error,
                );
            }
        }
    },
);

// POST /tabular-review/:reviewId/generate
tabularRouter.post("/:reviewId/generate", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();
    const generationAbort = new AbortController();
    const generationId = randomUUID();
    let leaseHeartbeat: ReturnType<typeof setInterval> | null = null;
    let renewingLease = false;
    req.on("aborted", () => generationAbort.abort());

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    const columns: {
        index: number;
        name: string;
        prompt: string;
        format?: string;
        tags?: string[];
    }[] = review.columns_config ?? [];
    if (columns.length === 0)
        return void res.status(400).json({ detail: "No columns configured" });

    const { tabular_model, api_keys, committees } = await getUserModelSettings(userId, db);
    const missingKey = missingModelApiKey(
            tabular_model,
            api_keys,
            committees,
        );
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    const expectedUpdatedAt = req.body?.expected_updated_at;
    if (
        typeof expectedUpdatedAt !== "string" ||
        !Number.isFinite(Date.parse(expectedUpdatedAt))
    ) {
        return void res.status(400).json({
            detail: "expected_updated_at must be a valid timestamp",
        });
    }
    if (generationAbort.signal.aborted || res.destroyed) return;

    const { data: startResult, error: startError } = await db.rpc(
        "begin_tabular_review_generation",
        {
            target_review_id: reviewId,
            expected_updated_at: expectedUpdatedAt,
            target_generation_id: generationId,
            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
        },
    );
    if (startError) {
        return void sendInternalError(res, startError);
    }
    if (startResult === "running") {
        return void res.status(409).json({
            code: "review_running",
            detail: "This tabular review is already running elsewhere.",
        });
    }
    if (startResult === "stale") {
        return void res.status(409).json({
            code: "review_stale",
            detail: "A newer version of this tabular review is available.",
        });
    }
    if (startResult === "not_found") {
        return void res.status(404).json({ detail: "Review not found" });
    }
    if (startResult !== "started") {
        return void res.status(500).json({
            detail: "Failed to start tabular review generation",
        });
    }
    // Everything used to decide which cells need work is loaded only after
    // the atomic lease claim. Otherwise, a request can snapshot pending cells
    // while another run is finishing, acquire the newly released lease, and
    // regenerate results that were completed after its stale snapshot.
    let rows: ReviewRow[] = [];
    const cellMap = new Map<string, Record<string, unknown>>();

    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) generationAbort.abort();
    });
    const write = (line: string) => {
        if (res.destroyed || res.writableEnded) return false;
        return res.write(line);
    };

    try {
        leaseHeartbeat = setInterval(() => {
            if (renewingLease || generationAbort.signal.aborted) return;
            renewingLease = true;
            void (async () => {
                try {
                    const { data, error } = await db.rpc(
                        "renew_tabular_review_generation",
                        {
                            target_review_id: reviewId,
                            target_generation_id: generationId,
                            lease_seconds: TABULAR_GENERATION_LEASE_SECONDS,
                        },
                    );
                    if (error || data !== true) generationAbort.abort();
                } catch {
                    generationAbort.abort();
                } finally {
                    renewingLease = false;
                }
            })();
        }, TABULAR_GENERATION_HEARTBEAT_MS);

        rows = await loadReviewRows(db, reviewId);
        const { data: cells, error: cellsError } = await db
            .from("tabular_cells")
            .select("*")
            .eq("review_id", reviewId);
        if (cellsError) {
            sendInternalError(res, cellsError);
            return;
        }
        for (const cell of cells ?? []) {
            cellMap.set(`${cell.row_id}:${cell.column_index}`, cell);
        }

        const sourceIds = [
            ...new Set(rows.flatMap((row) => row.source_document_ids ?? [])),
        ];
        const allowedSourceIds = new Set(
            await filterAccessibleDocumentIds(
                sourceIds,
                userId,
                userEmail,
                db,
            ),
        );
        rows = rows.filter((row) =>
            (row.source_document_ids ?? []).every((id) =>
                allowedSourceIds.has(id),
            ),
        );

        if (generationAbort.signal.aborted || res.destroyed) return;

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        let nextRowIndex = 0;
        const processRow = async (row: ReviewRow) => {
            if (generationAbort.signal.aborted) return;
            const markdown = await loadRowDocumentText(db, row);
            if (generationAbort.signal.aborted) return;

            // Filter to only columns that need processing.
            const columnsToProcess = columns.filter((col) => {
                const cell = cellMap.get(`${row.id}:${col.index}`);
                return !(cell?.status === "done" && cell?.content);
            });
            if (columnsToProcess.length === 0) return;

            // Mark only rows that have actually started as generating. Rows
            // still in the worker queue remain pending and can be resumed.
            for (const col of columnsToProcess) {
                write(
                    `data: ${JSON.stringify({ type: "cell_update", row_id: row.id, column_index: col.index, content: null, status: "generating" })}\n\n`,
                );
                const existingCell = cellMap.get(`${row.id}:${col.index}`);
                if (existingCell) {
                    await db
                        .from("tabular_cells")
                        .update({
                            status: "generating",
                            content: null,
                            generation_id: generationId,
                        })
                        .eq("id", existingCell.id);
                } else {
                    await db.from("tabular_cells").insert({
                        review_id: reviewId,
                        row_id: row.id,
                        document_id: row.document_id,
                        column_index: col.index,
                        status: "generating",
                        generation_id: generationId,
                    });
                }
            }

            // Single LLM call for all columns, streaming one JSON line per
            // column. Aborting the request stops every active worker.
            const receivedColumns = new Set<number>();
            try {
                await queryTabularAllColumns(
                    tabular_model,
                    row.label,
                    markdown,
                    columnsToProcess,
                    async (columnIndex, result) => {
                        receivedColumns.add(columnIndex);
                        await db
                            .from("tabular_cells")
                            .update({
                                content: JSON.stringify(result),
                                status: "done",
                                generation_id: null,
                            })
                            .eq("review_id", reviewId)
                            .eq("row_id", row.id)
                            .eq("column_index", columnIndex)
                            .eq("generation_id", generationId);
                        write(
                            `data: ${JSON.stringify({ type: "cell_update", row_id: row.id, column_index: columnIndex, content: result, status: "done" })}\n\n`,
                        );
                    },
                    api_keys,
                    generationAbort.signal,
                );
            } catch (err) {
                if (!generationAbort.signal.aborted) {
                    console.error(
                        `[tabular/generate] queryTabularAllColumns error row=${row.id}`,
                        err,
                    );
                }
            }

            // Stopped cells return to pending; genuine missing model output is
            // still an error. Completed cells remain untouched.
            const incompleteStatus = generationAbort.signal.aborted
                ? "pending"
                : "error";
            for (const col of columnsToProcess) {
                if (!receivedColumns.has(col.index)) {
                    await db
                        .from("tabular_cells")
                        .update({
                            status: incompleteStatus,
                            content: null,
                            generation_id: null,
                        })
                        .eq("review_id", reviewId)
                        .eq("row_id", row.id)
                        .eq("column_index", col.index)
                        .eq("generation_id", generationId);
                    write(
                        `data: ${JSON.stringify({ type: "cell_update", row_id: row.id, column_index: col.index, content: null, status: incompleteStatus })}\n\n`,
                    );
                }
            }
        };

        const runWorker = async () => {
            while (!generationAbort.signal.aborted) {
                const rowIndex = nextRowIndex++;
                if (rowIndex >= rows.length) return;
                await processRow(rows[rowIndex]);
            }
        };
        await Promise.all(
            Array.from(
                {
                    length: Math.min(
                        TABULAR_GENERATION_CONCURRENCY,
                        rows.length,
                    ),
                },
                () => runWorker(),
            ),
        );

        if (!generationAbort.signal.aborted) {
            void recordAudit(db, {
                userId,
                userEmail,
                action: "tabular.generated",
                surface: "tabular",
                reviewId,
            });
            write("data: [DONE]\n\n");
        }
    } catch (err) {
        if (!generationAbort.signal.aborted) {
            console.error("[tabular/generate] stream error", err);
            if (res.headersSent) {
                try {
                    write(
                        `data: ${JSON.stringify({ type: "error", message: ASSISTANT_ERROR_MESSAGE })}\n\ndata: [DONE]\n\n`,
                    );
                } catch {
                    /* ignore */
                }
            } else if (!res.destroyed && !res.writableEnded) {
                res.status(500).json({
                    detail: "Failed to prepare tabular review generation",
                });
            }
        }
    } finally {
        streamFinished = true;
        if (leaseHeartbeat) clearInterval(leaseHeartbeat);
        try {
            const { error } = await db.rpc(
                "finish_tabular_review_generation",
                {
                    target_review_id: reviewId,
                    target_generation_id: generationId,
                },
            );
            if (error) throw error;
        } catch (error) {
            console.error(
                "[tabular/generate] failed to release generation lease",
                error,
            );
        }
        if (!res.writableEnded) res.end();
    }
});

// GET /tabular-review/:reviewId/chats — list chats (metadata only, no messages)
tabularRouter.get("/:reviewId/chats", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const db = createServerSupabase();

    // Verify access (owner or shared-project member).
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("id, user_id, project_id")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Show every member's chats for the review (collaborative), not just
    // the requester's. Per-chat access is gated above by review access.
    const { data: chats } = await db
        .from("tabular_review_chats")
        .select("id, title, created_at, updated_at, user_id")
        .eq("review_id", reviewId)
        .order("updated_at", { ascending: false });

    res.json(chats ?? []);
});

// DELETE /tabular-review/:reviewId/chats/:chatId — delete a single chat
tabularRouter.delete(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        const db = createServerSupabase();
        // Owner-only delete — sibling collaborators shouldn't be able to wipe
        // each other's threads.
        const { error } = await db
            .from("tabular_review_chats")
            .delete()
            .eq("id", chatId)
            .eq("user_id", userId);
        if (error) return void sendInternalError(res, error);
        res.status(204).send();
    },
);

// PATCH /tabular-review/:reviewId/chats/:chatId — rename a chat
tabularRouter.patch(
    "/:reviewId/chats/:chatId",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const { chatId } = req.params;
        const title =
            typeof req.body?.title === "string" ? req.body.title.trim() : "";
        if (!title)
            return void res.status(400).json({ detail: "Title is required" });
        const db = createServerSupabase();
        // Owner-only rename — mirrors the delete rule above.
        const { error } = await db
            .from("tabular_review_chats")
            .update({ title: title.slice(0, 200) })
            .eq("id", chatId)
            .eq("user_id", userId);
        if (error) return void sendInternalError(res, error);
        res.status(204).send();
    },
);

// GET /tabular-review/:reviewId/chats/:chatId/messages — messages for a single chat
tabularRouter.get(
    "/:reviewId/chats/:chatId/messages",
    requireAuth,
    async (req, res) => {
        const userId = res.locals.userId as string;
        const userEmail = res.locals.userEmail as string | undefined;
        const { reviewId, chatId } = req.params;
        const db = createServerSupabase();

        const { data: review } = await db
            .from("tabular_reviews")
            .select("id, user_id, project_id")
            .eq("id", reviewId)
            .single();
        if (!review)
            return void res.status(404).json({ detail: "Review not found" });
        const access = await ensureReviewAccess(review, userId, userEmail, db);
        if (!access.ok)
            return void res.status(404).json({ detail: "Review not found" });

        const { data: chat, error: chatError } = await db
            .from("tabular_review_chats")
            .select("id, review_id")
            .eq("id", chatId)
            .single();
        if (chatError || !chat || chat.review_id !== reviewId)
            return void res.status(404).json({ detail: "Chat not found" });

        const { data: messages } = await db
            .from("tabular_review_chat_messages")
            .select("id, role, content, annotations, created_at")
            .eq("chat_id", chatId)
            .order("created_at", { ascending: true });

        res.json(messages ?? []);
    },
);

// ---------------------------------------------------------------------------
// Tabular citation parsing
// ---------------------------------------------------------------------------

type TabularParsedCitation = {
    ref: number;
    col_index: number;
    row_index: number;
    quote: string;
};

const TABULAR_CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;

function parseTabularCitations(text: string): TabularParsedCitation[] {
    const match = text.match(TABULAR_CITATIONS_BLOCK_RE);
    if (!match) return [];
    try {
        return JSON.parse(match[1]) as TabularParsedCitation[];
    } catch {
        return [];
    }
}

function extractTabularAnnotations(
    fullText: string,
    tabularStore: TabularCellStore,
) {
    return parseTabularCitations(fullText).map((c) => ({
        type: "tabular_citation" as const,
        ref: c.ref,
        col_index: c.col_index,
        row_index: c.row_index,
        col_name:
            tabularStore.columns[c.col_index]?.name ?? `Col ${c.col_index}`,
        doc_name:
            tabularStore.documents[c.row_index]?.filename ??
            `Row ${c.row_index}`,
        quote: c.quote,
    }));
}

// ---------------------------------------------------------------------------
// Build messages for tabular chat
// ---------------------------------------------------------------------------

function buildTabularMessages(
    messages: ChatMessage[],
    tabularStore: TabularCellStore,
    reviewTitle: string,
): unknown[] {
    const docList = tabularStore.documents
        .map((d, i) => `- ROW:${i} "${d.filename}"`)
        .join("\n");
    const colList = tabularStore.columns
        .map((c, i) => `- COL:${i} "${c.name}"`)
        .join("\n");

    const systemContent = `You are Mike, an AI legal assistant. You are helping with the tabular review titled "${reviewTitle}".

The review extracts specific fields from multiple legal documents into a structured table.
You do NOT have the cell content yet — call read_table_cells to fetch the cells you need before answering.

DOCUMENTS (rows):
${docList || "- (none)"}

COLUMNS (fields):
${colList || "- (none)"}

TABULAR CITATION INSTRUCTIONS:
When you reference specific cell content, place a numbered marker [1], [2], etc. inline in your prose at the point of reference.

After your complete response, append a <CITATIONS> block containing a JSON array with one entry per marker:

<CITATIONS>
[
  {"ref": 1, "col_index": 0, "row_index": 2, "quote": "verbatim text from the cell"},
  {"ref": 2, "col_index": 1, "row_index": 0, "quote": "another excerpt"}
]
</CITATIONS>

Rules:
- col_index and row_index are 0-based (matching the COL/ROW numbers listed above)
- Only cite cells you have read via read_table_cells
- quote should be verbatim text from the cell's summary
- Omit <CITATIONS> if you make no citations
- Do not fabricate cell content
- Answer in clear, concise prose. You may use markdown formatting.`;

    const formatted: unknown[] = [{ role: "system", content: systemContent }];
    for (const msg of messages) {
        formatted.push({ role: msg.role, content: msg.content ?? "" });
    }
    return formatted;
}

// ---------------------------------------------------------------------------
// POST /tabular-review/:reviewId/chat — agentic streaming
// ---------------------------------------------------------------------------

// POST /tabular-review/:reviewId/chat
tabularRouter.post("/:reviewId/chat", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { reviewId } = req.params;
    const {
        messages,
        chat_id: existingChatId,
        review_title: clientReviewTitle,
        project_name: clientProjectName,
    } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        review_title?: string;
        project_name?: string;
    };

    const lastUser = [...(messages ?? [])]
        .reverse()
        .find((m) => m.role === "user");
    if (!lastUser?.content?.trim()) {
        return void res
            .status(400)
            .json({ detail: "messages must include a user message" });
    }

    const db = createServerSupabase();
    const { data: review, error } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (error || !review)
        return void res.status(404).json({ detail: "Review not found" });
    const reviewAccess = await ensureReviewAccess(
        review,
        userId,
        userEmail,
        db,
    );
    if (!reviewAccess.ok)
        return void res.status(404).json({ detail: "Review not found" });

    // Fetch all cells and logical review rows for this review.
    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const rows = await loadReviewRows(db, reviewId);

    const sortedColumns = (
        (review.columns_config ?? []) as { index: number; name: string }[]
    ).sort((a, b) => a.index - b.index);

    const tabularStore: TabularCellStore = {
        columns: sortedColumns,
        documents: rows.map((row) => ({
            id: row.id,
            filename: row.label,
        })),
        cells: new Map(
            (cells ?? []).map((c: any) => [
                `${c.column_index}:${c.row_id}`,
                parseCellContent(c.content),
            ]),
        ),
    };

    const { tabular_model, api_keys, committees } = await getUserModelSettings(userId, db);
    const missingKey = missingModelApiKey(
            tabular_model,
            api_keys,
            committees,
        );
    if (missingKey) {
        return void res.status(422).json({
            code: "missing_api_key",
            ...missingKey,
        });
    }

    // Create or verify chat record
    let chatId = existingChatId ?? null;
    let chatTitle: string | null = null;
    const isFirstExchange =
        messages.filter((m) => m.role === "user").length === 1;

    if (chatId) {
        // The chat must belong to this exact review and to the requester.
        // Review access alone is not enough: otherwise a user could reuse one
        // of their chats from a different review in this route.
        const { data: existing } = await db
            .from("tabular_review_chats")
            .select("id, title, review_id, user_id")
            .eq("id", chatId)
            .single();
        const canUse =
            !!existing &&
            existing.review_id === reviewId &&
            existing.user_id === userId;
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        const { data: newChat } = await db
            .from("tabular_review_chats")
            .insert({ review_id: reviewId, user_id: userId })
            .select("id, title")
            .single();
        chatId = newChat?.id ?? null;
        chatTitle = newChat?.title ?? null;
    }

    // Persist user message
    if (chatId) {
        await db.from("tabular_review_chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
        });
    }

    const apiMessages = buildTabularMessages(
        messages,
        tabularStore,
        review.title || "Untitled Review",
    );

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (line: string) => res.write(line);
    const streamAbort = new AbortController();
    let streamFinished = false;
    res.on("close", () => {
        if (!streamFinished) streamAbort.abort();
    });

    if (chatId) {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);
    }

    try {
        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore: new Map(),
            docIndex: {},
            userId,
            db,
            write,
            extraTools: TABULAR_TOOLS,
            includeResearchTools: false,
            tabularStore,
            buildCitations: (text) =>
                extractTabularAnnotations(text, tabularStore),
            model: tabular_model,
            apiKeys: api_keys,
            signal: streamAbort.signal,
        });

        const persistedEvents = stripTransientAssistantEvents(events);
        const annotations = extractTabularAnnotations(fullText, tabularStore);

        if (chatId) {
            await db.from("tabular_review_chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: persistedEvents.length ? persistedEvents : null,
                annotations: annotations.length ? annotations : null,
            });
            await db
                .from("tabular_review_chats")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", chatId);
        }

        // Generate title on first exchange
        if (chatId && isFirstExchange && !chatTitle && lastUser.content) {
            const { title_model } = await getUserModelSettings(userId, db);
            const title = await generateChatTitle(
                title_model,
                lastUser.content,
                {
                    reviewTitle: clientReviewTitle ?? review.title ?? null,
                    projectName: clientProjectName ?? null,
                },
                api_keys,
            );
            if (title) {
                await db
                    .from("tabular_review_chats")
                    .update({ title })
                    .eq("id", chatId);
                write(
                    `data: ${JSON.stringify({ type: "chat_title", chatId, title })}\n\n`,
                );
            }
        }
    } catch (err) {
        if (isAbortError(err)) {
            console.log("[tabular/chat] client aborted stream", { chatId });
            if (chatId && err instanceof AssistantStreamError) {
                const partial = buildCancelledAssistantMessage({
                    fullText: err.fullText,
                    events: err.events,
                    buildCitations: (fullText) =>
                        extractTabularAnnotations(fullText, tabularStore),
                });
                const annotations = partial.citations;
                const { error: saveError } = await db
                    .from("tabular_review_chat_messages")
                    .insert({
                        chat_id: chatId,
                        role: "assistant",
                        content: partial.events.length ? partial.events : null,
                        annotations: annotations.length ? annotations : null,
                    });
                if (saveError) {
                    console.error(
                        "[tabular/chat] failed to save aborted stream",
                        saveError,
                    );
                }
                await db
                    .from("tabular_review_chats")
                    .update({ updated_at: new Date().toISOString() })
                    .eq("id", chatId);
            }
            return;
        }
        console.error("[tabular/chat] error", err);
        const message = ASSISTANT_ERROR_MESSAGE;
        const errorEvents =
            err instanceof AssistantStreamError
                ? stripTransientAssistantEvents(err.events)
                : [{ type: "error" as const, message }];
        const errorFullText =
            err instanceof AssistantStreamError ? err.fullText : "";
        if (chatId) {
            try {
                const annotations = extractTabularAnnotations(
                    errorFullText,
                    tabularStore,
                );
                const { error: saveError } = await db
                    .from("tabular_review_chat_messages")
                    .insert({
                        chat_id: chatId,
                        role: "assistant",
                        content: errorEvents.length ? errorEvents : null,
                        annotations: annotations.length ? annotations : null,
                    });
                if (saveError)
                    console.error(
                        "[tabular/chat] failed to save error",
                        saveError,
                    );
            } catch (saveErr) {
                console.error("[tabular/chat] failed to save error", saveErr);
            }
        }
        try {
            write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        streamFinished = true;
        res.end();
    }
});

function parseCellContent(
    raw: unknown,
): { summary: string; flag?: string; reasoning?: string } | null {
    if (!raw) return null;
    if (typeof raw === "object" && raw !== null && "summary" in raw) {
        const c = raw as {
            summary?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary: String(c.summary ?? ""),
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                c.flag as "green",
            )
                ? (c.flag as string)
                : undefined,
            reasoning: typeof c.reasoning === "string" ? c.reasoning : "",
        };
    }
    if (typeof raw === "string") {
        try {
            const p = JSON.parse(raw) as {
                summary?: unknown;
                value?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            return {
                summary: String(p.summary ?? p.value ?? "").trim(),
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    p.flag as "green",
                )
                    ? (p.flag as string)
                    : undefined,
                reasoning: typeof p.reasoning === "string" ? p.reasoning : "",
            };
        } catch {
            return { summary: raw, flag: "grey", reasoning: "" };
        }
    }
    return null;
}

async function queryTabularCell(
    model: string,
    filename: string,
    documentText: string,
    columnPrompt: string,
    format?: string,
    tags?: string[],
    apiKeys?: import("../lib/llm").UserApiKeys,
) {
    const suffix = formatPromptSuffix(format as never, tags);
    const fullPrompt = `${columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;

    const EXTRACTION_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[document:SOURCE_DOCUMENT_ID||page:N||quote:exact quoted text]], using the exact source document ID shown before the supporting document. For spreadsheets, use [[document:SOURCE_DOCUMENT_ID||sheet:SHEET_NAME||cell:A1||quote:exact cell text]]. The quote must be a short verbatim excerpt (≤ 25 words) narrowly scoped to the specific claim. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, precise quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

    let raw: string;
    try {
        raw = await completeText({
            model,
            systemPrompt: EXTRACTION_SYSTEM,
            user: `Document: ${filename}\n\n${documentText}\n\n---\nInstruction: ${fullPrompt}`,
            maxTokens: 2048,
            apiKeys,
        });
    } catch (err) {
        console.error(
            "[queryTabularCell] completion failed",
            err,
        );
        return null;
    }
    try {
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as {
            summary?: unknown;
            value?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary:
                String(parsed.summary ?? parsed.value ?? "").trim() ||
                "Not addressed",
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                parsed.flag as "green",
            )
                ? (parsed.flag as "green")
                : "grey",
            reasoning: String(parsed.reasoning ?? ""),
        };
    } catch {
        return raw.trim()
            ? {
                  summary: raw.trim().slice(0, 500),
                  flag: "grey" as const,
                  reasoning: "",
              }
            : null;
    }
}

async function generateChatTitle(
    model: string,
    firstUserMessage: string,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    apiKeys?: import("../lib/llm").UserApiKeys,
): Promise<string | null> {
    try {
        const contextLines: string[] = [];
        if (context?.projectName)
            contextLines.push(`Project: ${context.projectName}`);
        if (context?.reviewTitle)
            contextLines.push(`Tabular review: ${context.reviewTitle}`);
        const contextBlock = contextLines.length
            ? `This chat is in the context of a tabular review.\n${contextLines.join("\n")}\n\n`
            : "";

        const raw = await completeText({
            model,
            user: `${contextBlock}Generate a short title (4-6 words) for a chat that starts with the message below. The title should reflect the user's specific question, not the review or project name. Return only the title, no punctuation, no quotes:\n\n${firstUserMessage}`,
            maxTokens: 64,
            apiKeys,
        });
        return raw.trim().slice(0, 80) || null;
    } catch {
        return null;
    }
}

type CellResult = {
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
};
type Column = {
    index: number;
    name: string;
    prompt: string;
    format?: string;
    tags?: string[];
};

async function queryTabularAllColumns(
    model: string,
    filename: string,
    documentText: string,
    columns: Column[],
    onResult: (columnIndex: number, result: CellResult) => Promise<void>,
    apiKeys?: import("../lib/llm").UserApiKeys,
    abortSignal?: AbortSignal,
): Promise<void> {
    const columnsDesc = columns
        .map((col) => {
            const suffix = formatPromptSuffix(col.format as never, col.tags);
            const fullPrompt = `${col.prompt}${suffix} If not found, state "Not Found".`;
            return `Column ${col.index} — "${col.name}": ${fullPrompt}`;
        })
        .join("\n");

    const SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[document:SOURCE_DOCUMENT_ID||page:N||quote:verbatim excerpt ≤25 words]] after every factual claim, using the exact source document ID shown before the supporting document. For spreadsheets, use [[document:SOURCE_DOCUMENT_ID||sheet:SHEET_NAME||cell:A1||quote:exact cell text]]. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

    const USER = `Document: ${filename}\n\n${documentText}\n\n---\nColumns to extract:\n${columnsDesc}`;

    let contentBuffer = "";
    const pending: Promise<unknown>[] = [];

    const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed) as {
                column_index?: unknown;
                summary?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            if (typeof parsed.column_index !== "number") return;
            const col = columns.find((c) => c.index === parsed.column_index);
            if (!col) return;
            await onResult(parsed.column_index, {
                summary: String(parsed.summary ?? "").trim() || "Not addressed",
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    parsed.flag as "green",
                )
                    ? (parsed.flag as CellResult["flag"])
                    : "grey",
                reasoning: String(parsed.reasoning ?? ""),
            });
        } catch {
            // malformed line — skip
        }
    };

    let abortError: unknown;
    try {
        await streamChatWithTools({
            model,
            systemPrompt: SYSTEM,
            messages: [{ role: "user", content: USER }],
            tools: [],
            apiKeys,
            abortSignal,
            callbacks: {
                onContentDelta: (delta) => {
                    contentBuffer += delta;
                    let newlineIdx: number;
                    while ((newlineIdx = contentBuffer.indexOf("\n")) !== -1) {
                        const completedLine = contentBuffer.slice(
                            0,
                            newlineIdx,
                        );
                        contentBuffer = contentBuffer.slice(newlineIdx + 1);
                        pending.push(processLine(completedLine));
                    }
                },
            },
        });
    } catch (err) {
        if (abortSignal?.aborted) {
            abortError = err;
        } else {
            console.error(
                "[queryTabularAllColumns] stream failed",
                err,
            );
        }
    }

    if (contentBuffer.trim()) pending.push(processLine(contentBuffer));
    await Promise.all(pending);
    if (abortError) throw abortError;
}

async function extractDocumentMarkdown(
    buf: ArrayBuffer,
    fileType: string | null | undefined,
): Promise<string> {
    const normalizedType = (fileType ?? "").toLowerCase();
    if (normalizedType === "pdf") return extractPdfMarkdown(buf);
    if (normalizedType === "docx") return extractDocxMarkdown(buf);
    if (isSpreadsheetDocumentType(normalizedType)) {
        // SheetJS handles .xlsx/.xlsm/.xls directly, no PDF detour.
        return spreadsheetToLLMText(Buffer.from(buf));
    }
    if (normalizedType === "pptx") {
        return extractPresentationText(Buffer.from(buf));
    }
    if (
        isPresentationDocumentType(normalizedType) ||
        isWordDocumentType(normalizedType)
    ) {
        const pdfBuf = await docxToPdf(Buffer.from(buf));
        const pdfArrayBuffer = pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer;
        return extractPdfMarkdown(pdfArrayBuffer);
    }
    return extractDocxMarkdown(buf);
}

async function extractPdfMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await import(
            "pdfjs-dist/legacy/build/pdf.mjs" as string
        );
        const pdf = await (
            pdfjsLib as unknown as {
                getDocument: (opts: unknown) => {
                    promise: Promise<{
                        numPages: number;
                        getPage: (n: number) => Promise<{
                            getTextContent: () => Promise<{
                                items: { str?: string; hasEOL?: boolean }[];
                            }>;
                        }>;
                    }>;
                };
            }
        ).getDocument({ data: new Uint8Array(buf) }).promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items
                .filter((it): it is { str: string } => "str" in it)
                .map((it) => it.str)
                .join(" ")
                .trim();
            if (text) pages.push(`## Page ${i}\n\n${text}`);
        }
        return pages.join("\n\n");
    } catch {
        return "";
    }
}

async function extractDocxMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const mammoth = await import("mammoth");
        const normalized = await normalizeDocxZipPaths(Buffer.from(buf));
        const { value: html } = await mammoth.convertToHtml({
            buffer: normalized,
        });
        return html
            .replace(
                /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
                (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
            )
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}
