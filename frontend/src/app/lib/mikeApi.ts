import type {
    TabularReviewHistoryStatus,
    AuditActor,
    AuditActorPage,
    OrgMemberHandover,
    OrgDepartureList,
    OrgDepartureResolution,
} from "@mike/contracts";
export type {
    AuditActor,
    AuditActorPage,
    OrgMemberHandover,
    OrgDeparture,
    OrgDepartureItem,
    OrgDepartureList,
    OrgDepartureResolution,
} from "@mike/contracts";

/**
 * Mike API client — all browser requests use the same-origin `/api` gateway.
 * Authentication is carried only by the backend-managed HttpOnly cookie.
 */

import { isPanelDocument } from "@/app/components/shared/types";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { notifyTabularReviewsChanged } from "@/app/lib/tabularReviewChanges";
import type { RouterProfileLists } from "@/shared/lib/modelCatalog";
import {
    markErrorHandled,
    reportApiFailure,
    reportNetworkFailure,
    trackPendingRequest,
} from "@/app/lib/errorReporting";
import {
    UploadBatchError,
    createControlRequestRetryPolicy,
    failedUploadMessage,
    firstUploadResult,
    uploadFilesWithSessionCore,
    type UploadOutcome,
    type UploadProgress,
    type UploadProgressStatus,
    type UploadSessionInput,
    type UploadSessionPurpose,
} from "@/shared/api/uploadSessionClient";
// The role vocabulary is defined once, next to the capability matrix that
// gives it meaning, and re-exported here so API consumers do not need two
// imports to describe one row.
import type {
    InvitableOrgRole,
    OrgRole,
    OrganizationAccessOverride,
    ProjectRole,
} from "@/app/lib/permissions";

export type { OrgRole, ProjectRole };
export type AccessAssignmentRole = OrganizationAccessOverride;
import type {
    AskInputResponseItem,
    AssistantEvent,
    Chat,
    ChatDetailOut,
    ActiveAssistantTurn,
    Citation,
    ContentVisibility,
    Document,
    Folder,
    LibraryFolder,
    Message,
    MessageFile,
    PanelDocument,
    OpenSourceWorkflowContributorMode,
    OpenSourceWorkflowResponse,
    Project,
    QuickAction,
    Workflow,
    WorkflowAddon,
    WorkflowContributor,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";

export { UploadBatchError };
export { failedUploadMessage };
export type {
    UploadOutcome,
    UploadProgress,
    UploadProgressStatus,
    UploadSessionInput,
};

type AskInputsResponsePayload = {
    assistant_message_id: string;
    ask_event_id: string;
    responses: AskInputResponseItem[];
};

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: MessageFile[] | null;
    workflow?: { id: string; title: string } | null;
    citations?: Citation[] | null;
    created_at: string;
}
interface ServerChatDetailOut {
    chat: Chat;
    /** The caller's standing on this chat, served alongside the row. */
    is_owner?: boolean;
    access_role?: "owner" | "editor" | "viewer";
    messages: ServerMessage[];
    active_turn?: ActiveAssistantTurn | null;
}

export const API_BASE = "/api";
/**
 * Every API call goes through here so a transport failure (the request
 * never got an HTTP response) is reported once, tagged with the endpoint,
 * before it propagates as the bare TypeError the browser throws.
 */
const apiFetch: typeof fetch = async (input, init) => {
    const release = trackPendingRequest();
    try {
        return await authenticatedFetch(input, init);
    } catch (error) {
        // Stopping a stream or leaving a screen is expected. Abort reasons
        // may be arbitrary values, so the signal also covers custom reasons.
        if (
            init?.signal?.aborted ||
            (typeof error === "object" &&
                error !== null &&
                "name" in error &&
                error.name === "AbortError")
        ) {
            throw error;
        }
        reportNetworkFailure(error, {
            method: init?.method ?? "GET",
            url: String(input),
        });
        throw error;
    } finally {
        release();
    }
};
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

export class MikeApiError extends Error {
    status: number;
    code: string | null;
    requestId: string | null;

    constructor(args: {
        message: string;
        status: number;
        code?: string | null;
        requestId?: string | null;
    }) {
        super(args.message);
        this.name = "MikeApiError";
        this.status = args.status;
        this.code = args.code ?? null;
        this.requestId = args.requestId ?? null;
    }
}

export const INTERNAL_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const MALFORMED_ERROR_RESPONSE_MESSAGE =
    "The request could not be completed. Please try again.";
/**
 * The backend's answer when its database is missing a migration (PGRST202/
 * 204/205, 42P01). Unlike other 5xx it tells the user something actionable
 * — contact whoever runs the server — so it is shown instead of the generic
 * fallback (see userFacingApiError).
 */
export const SCHEMA_OUT_OF_DATE_CODE = "schema_out_of_date";
export const SCHEMA_OUT_OF_DATE_MESSAGE =
    "The server's database needs an update before this can load. Please contact your administrator.";
/**
 * The Next gateway's answer (503, Retry-After) when it cannot reach the
 * backend at all (ECONNREFUSED and friends). The gateway reports it once
 * per outage; the user can only wait and retry.
 */
export const UPSTREAM_UNAVAILABLE_CODE = "upstream_unavailable";
export const UPSTREAM_UNAVAILABLE_MESSAGE =
    "The server is temporarily unreachable. Please try again shortly.";
/**
 * 5xx codes that the server side (backend or gateway) has already reported
 * to Sentry, and that carry a message worth showing instead of the generic
 * fallback. The browser shows the message and does not report them again.
 */
const REPORTED_UPSTREAM_MESSAGES: Readonly<Record<string, string>> = {
    [SCHEMA_OUT_OF_DATE_CODE]: SCHEMA_OUT_OF_DATE_MESSAGE,
    [UPSTREAM_UNAVAILABLE_CODE]: UPSTREAM_UNAVAILABLE_MESSAGE,
};

/** The fixed user-facing message for a server-reported code, or null. */
export function reportedUpstreamMessage(code: string): string | null {
    return Object.hasOwn(REPORTED_UPSTREAM_MESSAGES, code)
        ? REPORTED_UPSTREAM_MESSAGES[code]
        : null;
}

export function isMfaRequiredError(error: unknown) {
    return (
        error instanceof MikeApiError &&
        error.status === 403 &&
        error.code === "mfa_verification_required"
    );
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const { headers: initHeaders, ...restInit } = init ?? {};
    const response = await apiFetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...restInit,
        headers: {
            Accept: "application/json",
            ...(initHeaders as Record<string, string> | undefined),
        },
    });

    if (!response.ok) {
        throw await toApiError(response, path, restInit.method ?? "GET");
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

/**
 * Every upload entry point takes the same options bag so a caller can watch
 * progress and cancel the batch (an unmounting screen, a "stop" control)
 * without reaching past the API layer.
 */
export type UploadRequestOptions<T> = {
    onProgress?: (progress: UploadProgress<T>) => void;
    signal?: AbortSignal;
};

export async function uploadFilesWithSession<T>(args: {
    purpose: UploadSessionPurpose;
    destination: Record<string, unknown>;
    files: UploadSessionInput[];
    signal?: AbortSignal;
    onProgress?: (progress: UploadProgress<T>) => void;
}): Promise<UploadOutcome<T>[]> {
    return uploadFilesWithSessionCore<T>({
        ...args,
        transport: {
            apiRequest,
            fetchStorage: (...fetchArgs) => fetch(...fetchArgs),
            shouldRetryControlRequest: createControlRequestRetryPolicy(
                (error) =>
                    error instanceof MikeApiError
                        ? { status: error.status, code: error.code }
                        : null,
            ),
        },
    });
}

async function apiBlobRequest(path: string): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    const response = await apiFetch(`${API_BASE}${path}`, {
        cache: "no-store",
        headers: {
            Accept: "application/json",
        },
    });

    if (!response.ok) {
        throw await toApiError(response, path);
    }

    const disposition = response.headers.get("content-disposition") ?? "";
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    return {
        blob: await response.blob(),
        filename: filenameMatch?.[1] ?? null,
    };
}

async function toApiError(
    response: Response,
    path: string,
    method = "GET",
) {
    const text = await response.text();
    try {
        const parsed = JSON.parse(text) as {
            detail?: unknown;
            code?: unknown;
            request_id?: unknown;
        };
        const requestId =
            typeof parsed.request_id === "string"
                ? parsed.request_id
                : response.headers.get("x-request-id");
        devLog("[mike-api] non-ok response", {
            path,
            status: response.status,
            code: parsed.code,
            requestId,
        });
        const code = typeof parsed.code === "string" ? parsed.code : null;
        const upstreamMessage = code ? reportedUpstreamMessage(code) : null;
        if (upstreamMessage) {
            // The backend (schema_out_of_date) or the gateway
            // (upstream_unavailable) has already reported this failure once,
            // with detail the browser cannot see. A browser copy would be one
            // more event per endpoint per page view for the same incident —
            // the per-route fan-out again — so it is only marked: a screen's
            // console.error of it is not bridged either. The message is
            // ours, not the body's `detail`.
            const upstreamError = new MikeApiError({
                status: response.status,
                code,
                requestId,
                message: upstreamMessage,
            });
            markErrorHandled(upstreamError);
            return upstreamError;
        }
        const apiError = new MikeApiError({
            status: response.status,
            code,
            requestId,
            // A 4xx whose body carries no usable `detail` is a malformed
            // error response, and it is treated as one. `API error: 409` used
            // to be produced here instead — and because a 4xx message is the
            // one userFacingApiError shows VERBATIM (on the assumption that a
            // 4xx says something the user can act on), it reached the screen:
            // "Account not deleted / API error: 409". The catch arm below
            // already has the right sentence for "the server did not tell us
            // what went wrong"; this arm now uses it too.
            message:
                response.status >= 500
                    ? INTERNAL_ERROR_MESSAGE
                    : typeof parsed.detail === "string" && parsed.detail
                      ? parsed.detail
                      : MALFORMED_ERROR_RESPONSE_MESSAGE,
        });
        // 4xx are intentional answers (validation, permissions) and are
        // shown to the user; 5xx are failures worth an alert, correlated to
        // the backend's own event by request id.
        if (response.status >= 500) {
            reportApiFailure({
                path,
                method,
                status: response.status,
                code: apiError.code,
                requestId,
                error: apiError,
            });
        }
        return apiError;
    } catch {
        devLog("[mike-api] non-ok non-json response", {
            path,
            status: response.status,
            requestId: response.headers.get("x-request-id"),
        });
        const apiError = new MikeApiError({
            status: response.status,
            requestId: response.headers.get("x-request-id"),
            message:
                response.status >= 500
                    ? INTERNAL_ERROR_MESSAGE
                    : MALFORMED_ERROR_RESPONSE_MESSAGE,
        });
        if (response.status >= 500) {
            reportApiFailure({
                path,
                method,
                status: response.status,
                requestId: apiError.requestId,
                error: apiError,
            });
        }
        return apiError;
    }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(options?: {
    includeDocuments?: boolean;
    participatingOnly?: boolean;
    workspace?: string;
}): Promise<Project[]> {
    const params = new URLSearchParams();
    if (options?.includeDocuments) params.set("include", "documents");
    if (options?.participatingOnly) params.set("participating", "true");
    if (options?.workspace) params.set("workspace", options.workspace);
    // Workspace filters select the paginated backend overload. Pickers still
    // need the full list, including projects beyond its default first page.
    if (options?.workspace && !options.participatingOnly) {
        const projects: Project[] = [];
        const pageSize = 100;
        params.set("limit", String(pageSize));
        for (;;) {
            params.set("offset", String(projects.length));
            const page = await apiRequest<Project[]>(`/projects?${params.toString()}`);
            projects.push(...page);
            if (page.length < pageSize) return projects;
        }
    }
    const query = params.size ? `?${params.toString()}` : "";
    return apiRequest<Project[]>(`/projects${query}`);
}

// Paginated overview sibling of listProjects(), used by ProjectsOverview.tsx.
// Deliberately a separate function, not an overload of listProjects — the
// backend route decides whether to paginate based on whether any of these
// query params are present. Participation pickers keep the full unpaginated
// list when only the workspace filter is supplied.
export async function listProjectsPage(pagination?: {
    limit?: number;
    offset?: number;
    search?: string;
    sortKey?: string;
    sortDirection?: "asc" | "desc";
    scope?:
        | "all"
        | "mine"
        | "shared"
        | "collaborative"
        | "private"
        | "public"
        | "nonpublic";
    practice?: string;
    ownerUserId?: string;
    workspace?: string;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams();
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);
    if (pagination?.practice) params.set("practice", pagination.practice);
    if (pagination?.ownerUserId)
        params.set("owner_user_id", pagination.ownerUserId);
    if (pagination?.workspace) params.set("workspace", pagination.workspace);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<Project[]>(`/projects${qs}`, {
        signal: pagination?.signal,
    });
}

export async function listProjectSummaries(pagination?: {
    limit?: number;
    offset?: number;
    workspace?: string;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams();
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    params.set("view", "summary");
    if (pagination?.workspace) params.set("workspace", pagination.workspace);
    return apiRequest<Project[]>(`/projects?${params.toString()}`, {
        signal: pagination?.signal,
    });
}

interface ProjectDirectoryLevel {
    documents: Document[];
    folders: Folder[];
    documentsHasMore: boolean;
}

export async function getProjectDirectoryLevel(
    projectId: string,
    options?: {
        parentFolderId?: string | null;
        limit?: number;
        offset?: number;
        signal?: AbortSignal;
    },
): Promise<ProjectDirectoryLevel> {
    const params = new URLSearchParams();
    if (options?.parentFolderId)
        params.set("parent_folder_id", options.parentFolderId);
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.offset != null) params.set("offset", String(options.offset));
    const query = params.toString();
    return apiRequest<ProjectDirectoryLevel>(
        `/projects/${projectId}/directory${query ? `?${query}` : ""}`,
        {
            signal: options?.signal,
        },
    );
}

export async function searchProjectDirectory(options: {
    search: string;
    limit?: number;
    offset?: number;
    /** Narrow to one workspace: "personal" or an organization's id. */
    workspace?: string;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams({
        view: "directory-search",
        search: options.search,
    });
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.offset != null) params.set("offset", String(options.offset));
    if (options.workspace) params.set("workspace", options.workspace);
    return apiRequest<Project[]>(`/projects?${params}`, {
        signal: options.signal,
    });
}

export async function listProjectIds(options?: {
    search?: string;
    scope?:
        | "all"
        | "mine"
        | "shared"
        | "collaborative"
        | "private"
        | "public"
        | "nonpublic";
    practice?: string;
    ownerUserId?: string;
    workspace?: string;
    signal?: AbortSignal;
}): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    if (options?.practice) params.set("practice", options.practice);
    if (options?.ownerUserId) params.set("owner_user_id", options.ownerUserId);
    if (options?.workspace) params.set("workspace", options.workspace);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(`/projects/ids${qs}`, {
        signal: options?.signal,
    });
}

export interface ProjectFilterOptions {
    practices: string[];
    owners: {
        value: string;
        label: string;
        display_name?: string | null;
        email?: string | null;
        profile_photo?: string | null;
    }[];
}

export async function getProjectFilterOptions(
    signal?: AbortSignal,
    workspace?: string,
): Promise<ProjectFilterOptions> {
    const qs = workspace
        ? `?${new URLSearchParams({ workspace }).toString()}`
        : "";
    return apiRequest<ProjectFilterOptions>(`/projects/filter-options${qs}`, {
        signal,
    });
}

export async function createProject(
    name: string,
    cm_number?: string,
    practice?: string,
    org_id?: string,
    memory_enabled?: boolean,
    visibility?: ContentVisibility,
): Promise<Project> {
    return apiRequest<Project>("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            cm_number,
            practice,
            org_id,
            memory_enabled,
            visibility,
        }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function deleteAllChats(): Promise<void> {
    return apiRequest<void>("/user/chats", { method: "DELETE" });
}

export async function deleteAllProjects(): Promise<void> {
    return apiRequest<void>("/user/projects", { method: "DELETE" });
}

export async function deleteAllTabularReviews(): Promise<void> {
    return apiRequest<void>("/user/tabular-reviews", { method: "DELETE" });
}

export async function deleteAllMemories(): Promise<void> {
    return apiRequest<void>("/user/memories", { method: "DELETE" });
}

export type MemoryStatus = "idle" | "scheduled" | "processing" | "failed";

export interface MemoryCurrent {
    enabled: boolean;
    content: string;
    /** Monotonic change token for compare-and-swap; nothing is kept per value. */
    revision: number;
    hash: string | null;
    updated_at: string | null;
    /** Actor provenance only. The endpoint deliberately does not expose email. */
    updated_by: string | null;
    source: "manual" | "curator" | "wipe" | "settings" | null;
    status: MemoryStatus;
    /** Changes whenever scheduling, processing, or failure status changes. */
    status_updated_at?: string;
}

/**
 * The caller's own memory. They have one per workspace — Personal, and one
 * for each organization they belong to — each private to them. `workspace`
 * names which ("personal" or an organization id); omitted, it is Personal.
 */
function userMemoryPath(path: string, workspace?: string): string {
    return workspace
        ? `${path}?${new URLSearchParams({ workspace }).toString()}`
        : path;
}

export async function getUserMemory(
    signal?: AbortSignal,
    workspace?: string,
): Promise<MemoryCurrent> {
    return apiRequest<MemoryCurrent>(userMemoryPath("/user/memory", workspace), {
        signal,
    });
}

export async function updateUserMemory(
    content: string,
    expectedRevision: number,
    workspace?: string,
): Promise<MemoryCurrent> {
    return apiRequest<MemoryCurrent>(userMemoryPath("/user/memory", workspace), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content,
            expected_revision: expectedRevision,
        }),
    });
}

export async function setUserMemoryEnabled(
    enabled: boolean,
    workspace?: string,
): Promise<MemoryCurrent> {
    return apiRequest<MemoryCurrent>(
        userMemoryPath("/user/memory/settings", workspace),
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

export async function getProjectMemory(
    projectId: string,
    signal?: AbortSignal,
): Promise<MemoryCurrent> {
    return apiRequest<MemoryCurrent>(
        `/projects/${encodeURIComponent(projectId)}/memory`,
        { signal },
    );
}

export async function updateProjectMemory(
    projectId: string,
    content: string,
    expectedRevision: number,
): Promise<MemoryCurrent> {
    return apiRequest<MemoryCurrent>(
        `/projects/${encodeURIComponent(projectId)}/memory`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content,
                expected_revision: expectedRevision,
            }),
        },
    );
}

export async function setProjectMemoryEnabled(
    projectId: string,
    enabled: boolean,
): Promise<MemoryCurrent> {
    return apiRequest<MemoryCurrent>(
        `/projects/${encodeURIComponent(projectId)}/memory/settings`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

// --- Async (durable) exports -----------------------------------------------
// POST schedules a backend job that builds the export off the request thread;
// the status endpoint is polled until "done"; the download endpoint streams
// the artifact. Unlike a synchronous GET export, a large export can
// neither time out the request nor die with a closed tab, and a re-click
// while one is building dedupes onto the running job.

export type UserExportType =
    | "account"
    | "chats"
    | "tabular-reviews"
    | "audit-csv"
    | "documents-zip"
    | "memory-zip";

export type UserExportStatus =
    | { status: "pending" }
    | { status: "failed" }
    | { status: "done"; filename: string | null };

/**
 * `params` carries the inputs of the filtered exports — the History CSV's
 * filter values (including username and event_ids for selected audit entries)
 * and documents-zip's `document_ids`. The backend re-validates them and 400s
 * on anything it would have rejected on the synchronous route.
 */
export async function startUserExport(
    type: UserExportType,
    params?: Record<string, unknown>,
): Promise<{ export_id: string }> {
    return apiRequest<{ export_id: string }>("/user/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params ? { type, params } : { type }),
    });
}

export async function getUserExportStatus(
    exportId: string,
): Promise<UserExportStatus> {
    return apiRequest<UserExportStatus>(
        `/user/exports/${encodeURIComponent(exportId)}`,
    );
}

export async function downloadUserExport(exportId: string): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest(
        `/user/exports/${encodeURIComponent(exportId)}/download`,
    );
}

export type PracticeSetting =
    "private_practice" | "in_house" | "not_practising";

export type ProfessionalTitle =
    | "Partner"
    | "Senior Associate"
    | "Associate"
    | "Law Clerk"
    | "Counsel"
    | "General Counsel"
    | "Legal Counsel"
    | "Other";

export interface PersonalisationDetails {
    jurisdiction?: string | null;
    practiceSetting?: PracticeSetting | null;
    professionalTitle?: ProfessionalTitle | null;
    practiceAreas?: string[];}

export interface UserProfile extends RouterProfileLists {
    profilePhoto?: string | null;
    displayName: string | null;
    organisation: string | null;
    jurisdiction: string | null;
    practiceSetting: PracticeSetting | null;
    professionalTitle: ProfessionalTitle | null;
    practiceAreas: string[];
    onboardingVersion: number | null;
    onboardingComplete: boolean;
    passwordSet: boolean;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string | null;
    tabularModel: string | null;
    memoryCuratorModel: string | null;
    lastSelectedChatModel: string | null;
    lastSelectedReasoningLevel: NonNullable<Message["reasoning"]>;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    quickActionsVisible: boolean;
    darkMode: boolean;
    projectMemoryDefault: boolean;
    apiKeyStatus: ApiKeyStatus;
}

/** Uploads a cropped profile-photo data URL, or removes the current photo when passed null. */
export async function setUserProfilePhoto(photo: string | null): Promise<{ profilePhoto: string | null }> {
    return apiRequest("/user/profile/photo", photo === null
        ? { method: "DELETE" }
        : {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data_url: photo }),
        });
}

export interface UserLookupResult {
    exists: boolean;
    email: string;
    display_name: string | null;
}

// ---------------------------------------------------------------------------
// Audit history
// ---------------------------------------------------------------------------

export interface AuditEvent {
    org_id?: string | null;
    id: string;
    created_at: string;
    user_display_name: string | null;
    /** Current name of the affected member or invitation recipient. */
    affected_user_display_name?: string | null;
    /** Current photo of an actor in the authorized organization audit page. */
    user_profile_photo?: string | null;
    user_email: string | null;
    action: string;
    status: string;
    title: string | null;
    surface: string | null;
    project_id: string | null;
    chat_id: string | null;
    document_id: string | null;
    review_id: string | null;
    model: string | null;
    detail: Record<string, unknown> | null;
}

export async function getAuditHistory(
    params: {
        orgId?: string;
        username?: string;
        actorUserId?: string;
        q?: string;
        action?: string;
        status?: string;
        surface?: string;
        from?: string;
        to?: string;
        sortBy?: "created_at" | "user_email" | "title" | "model";
        sortDirection?: "asc" | "desc";
        page?: number;
    },
    signal?: AbortSignal,
): Promise<{
    events: AuditEvent[];
    total: number;
    page: number;
    pageSize: number;
}> {
    const qs = new URLSearchParams();
    if (params.orgId) qs.set("org_id", params.orgId);
    if (params.username) qs.set("username", params.username);
    if (params.actorUserId) qs.set("actor_user_id", params.actorUserId);
    if (params.q) qs.set("q", params.q);
    if (params.action) qs.set("action", params.action);
    if (params.status) qs.set("status", params.status);
    if (params.surface) qs.set("surface", params.surface);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.sortBy) qs.set("sort_by", params.sortBy);
    if (params.sortDirection) qs.set("sort_dir", params.sortDirection);
    if (params.page) qs.set("page", String(params.page));
    return apiRequest(`/audit?${qs.toString()}`, { signal });
}

/** Search the people represented in an organization's audit log, one page at a time. */
export async function getAuditActors(
    params: { orgId: string; search?: string; offset?: number },
    signal?: AbortSignal,
): Promise<AuditActorPage> {
    const qs = new URLSearchParams({ org_id: params.orgId });
    if (params.search) qs.set("q", params.search);
    if (params.offset) qs.set("offset", String(params.offset));
    return apiRequest(`/audit/actors?${qs.toString()}`, { signal });
}

export async function getUserProfile(): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile");
}

export async function lookupUserByEmail(
    email: string,
): Promise<UserLookupResult> {
    return apiRequest<UserLookupResult>(
        `/user/lookup?email=${encodeURIComponent(email)}`,
    );
}

export async function updateUserProfile(payload: {
    displayName?: string | null;
    organisation?: string | null;
    jurisdiction?: string | null;
    practiceSetting?: PracticeSetting | null;
    professionalTitle?: ProfessionalTitle | null;
    practiceAreas?: string[];
    titleModel?: string | null;
    tabularModel?: string | null;
    memoryCuratorModel?: string | null;
    lastSelectedChatModel?: string | null;
    lastSelectedReasoningLevel?: NonNullable<Message["reasoning"]>;
    legalResearchUs?: boolean;
    quickActionsVisible?: boolean;
    darkMode?: boolean;
    projectMemoryDefault?: boolean;
} & Partial<RouterProfileLists>): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export interface CustomInstructions {
    content: string;
}

export async function getCustomInstructions(
    signal?: AbortSignal,
): Promise<CustomInstructions> {
    return apiRequest<CustomInstructions>("/user/custom-instructions", {
        signal,
    });
}

export async function updateCustomInstructions(
    content: string,
): Promise<CustomInstructions> {
    return apiRequest<CustomInstructions>("/user/custom-instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
    });
}

/**
 * Mirrors RESPONSE_STYLE_OPTIONS in the backend user module. The language
 * codes mirror backend/src/lib/responseLanguages.ts and are listed in the
 * order the selector shows them.
 */
export const RESPONSE_STYLE_OPTIONS = {
    verbosity: ["concise", "balanced", "detailed"],
    formatting: ["balanced", "less", "more"],
    tone: ["formal", "balanced", "plain"],
    language: [
        "auto",
        "en-US",
        "en-GB",
        "ar",
        "zh-Hans",
        "zh-Hant",
        "cs",
        "da",
        "nl",
        "fi",
        "fr",
        "de",
        "el",
        "he",
        "hi",
        "id",
        "it",
        "ja",
        "ko",
        "ms",
        "nb",
        "pl",
        "pt-BR",
        "pt-PT",
        "ru",
        "es",
        "sv",
        "th",
        "tr",
        "uk",
        "vi",
    ],
} as const;

export type ResponseStyleField = keyof typeof RESPONSE_STYLE_OPTIONS;

export type ResponseStyle = {
    [Field in ResponseStyleField]: (typeof RESPONSE_STYLE_OPTIONS)[Field][number];
};

export async function getResponseStyle(
    signal?: AbortSignal,
): Promise<ResponseStyle> {
    return apiRequest<ResponseStyle>("/user/response-style", { signal });
}

/** Sends only the changed fields; the response is the full saved style. */
export async function updateResponseStyle(
    update: Partial<ResponseStyle>,
): Promise<ResponseStyle> {
    return apiRequest<ResponseStyle>("/user/response-style", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
    });
}

export async function completeUserOnboarding(
    payload: PersonalisationDetails = {},
): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function syncUserPasswordSet(): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/security/password-set", {
        method: "POST",
    });
}

export async function updateUserMfaOnLogin(
    enabled: boolean,
): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/security/mfa-login", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
}

export type ApiKeyProvider =
    | "claude"
    | "gemini"
    | "openai"
    | "mistral"
    | "openrouter"
    | "vercel"
    | "opencode-go"
    | "bedrock"
    | "azure"
    | "azure-foundry"
    | "vertex"
    | "xai"
    | "custom"
    | "courtlistener";
/**
 * Whose key a provider runs on: the person's own, their organization's, or
 * the deployment's. "org" only ever appears in an organization's status.
 */
type ApiKeySource = "user" | "org" | "env" | null;

/**
 * The non-secret setting saved with a user's own key: the AWS region of a
 * Bedrock key, the Azure resource of an Azure OpenAI or Azure AI Foundry key,
 * the Vertex AI location of a service-account key, the base URL of a custom
 * OpenAI-compatible endpoint.
 */
export type ApiKeySettings = {
    bedrock?: { region: string } | null;
    azure?: { endpoint: string } | null;
    "azure-foundry"?: { endpoint: string } | null;
    vertex?: { location: string } | null;
    custom?: { baseUrl: string } | null;
};
export type ApiKeyState = Record<
    ApiKeyProvider,
    {
        configured: boolean;
        source: ApiKeySource;
        enabled?: boolean;
    }
>;

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
    enabled?: Partial<Record<ApiKeyProvider, boolean>>;
    settings?: ApiKeySettings;
};

export interface OllamaModelOption {
    id: string;
    label: string;
    group: "Local";
}

export interface ConfiguredModelOption {
    id: string;
    label: string;
    group: "Configured";
    location: "cloud" | "local";
    source: "Configured";
}

export interface RouterCatalogModel {
    id: string;
    label: string;
    pricing?: {
        input?: string;
        output?: string;
        variesByProvider?: boolean;
        tiered?: boolean;
    };
}

export async function getOllamaModels(): Promise<OllamaModelOption[]> {
    const { models } = await apiRequest<{ models: OllamaModelOption[] }>(
        "/models/ollama",
    );
    return models;
}

export async function getConfiguredModels(): Promise<ConfiguredModelOption[]> {
    const { models } = await apiRequest<{ models: ConfiguredModelOption[] }>(
        "/models/configured",
    );
    return models;
}

/**
 * A provider's model catalog. With `workspace` set to an organization id it
 * is listed with the key that organization's work runs on — how its admins
 * choose the models its key may run — and otherwise with the caller's own.
 */
async function getProviderCatalog(
    provider: string,
    workspace?: string,
): Promise<RouterCatalogModel[]> {
    const query = workspace
        ? `?workspace=${encodeURIComponent(workspace)}`
        : "";
    const { models } = await apiRequest<{ models: RouterCatalogModel[] }>(
        `/models/${provider}${query}`,
    );
    return models;
}

export function getOpenRouterModels(
    workspace?: string,
): Promise<RouterCatalogModel[]> {
    return getProviderCatalog("openrouter", workspace);
}

export function getVercelModels(
    workspace?: string,
): Promise<RouterCatalogModel[]> {
    return getProviderCatalog("vercel", workspace);
}

export function getBedrockModels(
    workspace?: string,
): Promise<RouterCatalogModel[]> {
    return getProviderCatalog("bedrock", workspace);
}

export function getXaiModels(
    workspace?: string,
): Promise<RouterCatalogModel[]> {
    return getProviderCatalog("xai", workspace);
}

/** Models reported by the user's own OpenAI-compatible endpoint. */
export function getCustomEndpointModels(
    workspace?: string,
): Promise<RouterCatalogModel[]> {
    return getProviderCatalog("custom", workspace);
}

export function getOpenCodeGoModels(
    workspace?: string,
): Promise<RouterCatalogModel[]> {
    return getProviderCatalog("opencode-go", workspace);
}

/**
 * Save, replace or remove a key. Keys that are saved with a setting (a region,
 * endpoint, location or base URL) also send it; a setting with a null key changes the saved key's setting only.
 */
export async function saveApiKey(
    provider: ApiKeyProvider,
    apiKey: string | null,
    settings?: ApiKeySettings[keyof ApiKeySettings],
): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
            settings ? { api_key: apiKey, settings } : { api_key: apiKey },
        ),
    });
}

export async function setApiKeyEnabled(
    provider: ApiKeyProvider,
    enabled: boolean,
): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
}

interface McpToolSummary {
    id: string;
    toolName: string;
    openaiToolName: string;
    title: string | null;
    description: string | null;
    enabled: boolean;
    readOnly: boolean;
    destructive: boolean;
    /** Changes data; held for approval when the connector asks for permission. */
    write: boolean;
    lastSeenAt: string;
}

export interface McpConnectorSummary {
    id: string;
    name: string;
    transport: "streamable_http";
    serverUrl: string;
    authType: "none" | "bearer" | "oauth";
    enabled: boolean;
    requireWriteApproval: boolean;
    /** Disables write tools while preserving individual tool choices. */
    readOnly?: boolean;
    hasAuthConfig: boolean;
    customHeaderKeys: string[];
    oauthConnected: boolean;
    toolPolicy: Record<string, unknown>;
    tools: McpToolSummary[];
    toolCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface McpConnectorCreateResult {
    connector: McpConnectorSummary;
    oauthRequired: boolean;
}

export async function listMcpConnectors(): Promise<McpConnectorSummary[]> {
    return apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
}

export async function getMcpConnector(
    connectorId: string,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}`,
    );
}

export async function createMcpConnector(payload: {
    name: string;
    serverUrl: string;
    bearerToken?: string | null;
    headers?: Record<string, string>;
}): Promise<McpConnectorCreateResult> {
    return apiRequest<McpConnectorCreateResult>("/user/mcp-connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateMcpConnector(
    connectorId: string,
    payload: {
        name?: string;
        serverUrl?: string;
        enabled?: boolean;
        requireWriteApproval?: boolean;
        readOnly?: boolean;
        bearerToken?: string | null;
        headers?: Record<string, string>;
    },
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function deleteMcpConnector(connectorId: string): Promise<void> {
    return apiRequest<void>(`/user/mcp-connectors/${connectorId}`, {
        method: "DELETE",
    });
}

export async function refreshMcpConnectorTools(
    connectorId: string,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}/refresh-tools`,
        { method: "POST" },
    );
}

export async function startMcpConnectorOAuth(connectorId: string): Promise<{
    authorizationUrl: string | null;
    alreadyAuthorized: boolean;
    callbackOrigin: string;
}> {
    return apiRequest<{
        authorizationUrl: string | null;
        alreadyAuthorized: boolean;
        callbackOrigin: string;
    }>(`/user/mcp-connectors/${connectorId}/oauth/start`, { method: "POST" });
}

export async function setMcpToolEnabled(
    connectorId: string,
    toolId: string,
    enabled: boolean,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}/tools/${toolId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

// ---------------------------------------------------------------------------
// Native Google Drive integration (first-party — not an MCP connector)
// ---------------------------------------------------------------------------

export type GoogleDriveStatus = import("@mike/contracts").GoogleDriveStatus;

/**
 * Error code the backend attaches when a connector cannot start because the
 * deployment is missing operator-side setup (an OAuth client for a provider
 * with no dynamic registration). Its `detail` is repo-authored setup text
 * safe to show verbatim — unlike every other connector failure, which the
 * backend sanitizes to a fixed string.
 */
export const CONNECTOR_SETUP_REQUIRED_CODE = "connector_setup_required";

export function isConnectorSetupError(error: unknown): error is MikeApiError {
    return (
        error instanceof MikeApiError &&
        error.code === CONNECTOR_SETUP_REQUIRED_CODE
    );
}

export async function getGoogleDriveStatus(): Promise<GoogleDriveStatus> {
    return apiRequest<GoogleDriveStatus>("/user/integrations/google-drive");
}

export async function startGoogleDriveOAuth(): Promise<{
    authorizationUrl: string;
}> {
    return apiRequest<{ authorizationUrl: string }>(
        "/user/integrations/google-drive/oauth/start",
        { method: "POST" },
    );
}

export async function cancelGoogleDriveOAuth(state: string): Promise<void> {
    await apiRequest("/user/integrations/google-drive/oauth/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
    });
}

export async function disconnectGoogleDrive(): Promise<void> {
    return apiRequest<void>("/user/integrations/google-drive", {
        method: "DELETE",
    });
}

export async function updateGoogleDriveSettings(settings: {
    enabled?: boolean;
    requireWriteApproval?: boolean;
    readOnly?: boolean;
}): Promise<GoogleDriveStatus> {
    return apiRequest<GoogleDriveStatus>("/user/integrations/google-drive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
    });
}

export async function setGoogleDriveToolEnabled(
    toolName: string,
    enabled: boolean,
): Promise<GoogleDriveStatus> {
    return apiRequest<GoogleDriveStatus>(
        `/user/integrations/google-drive/tools/${encodeURIComponent(toolName)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

export async function getProject(projectId: string): Promise<Project> {
    return apiRequest<Project>(`/projects/${projectId}`);
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
        practice?: string | null;
        visibility?: ContentVisibility;
    },
): Promise<Project> {
    return apiRequest<Project>(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

/**
 * Someone who can administer a resource, with an address to reach them.
 * `source` says how they got there: the creator, a direct Owner grant, or
 * being an Owner or Admin of the owning organization.
 */
export interface ProjectContact {
    user_id: string | null;
    email: string | null;
    display_name: string | null;
    source: "creator" | "grant" | "organization";
}

export interface ProjectPeople {
    scope?: "direct" | "organization" | "project";
    inherited_from_project_id?: string;
    /**
     * The creator. Null is legitimate: an organization's project outlives the
     * account that opened it, and the org's admins administer it from then on.
     */
    owner: {
        user_id: string;
        email: string | null;
        display_name: string | null;
        profile_photo?: string | null;
        role?: ProjectRole;
    } | null;
    /** Direct recipients and their grant roles. */
    members: {
        user_id?: string | null;
        email: string;
        display_name: string | null;
        profile_photo?: string | null;
        role?: AccessAssignmentRole;
    }[];
    admin_contacts?: ProjectContact[];
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Project access grants
// ---------------------------------------------------------------------------
//
// One row per recipient, each carrying its own project role. This replaces the
// roleless `shared_with` email array. Direct grants belong only to personal
// resources; organization resources use organization-member overrides.

export interface ProjectGrant {
    id?: string;
    project_id?: string;
    user_id?: string;
    email: string;
    role: AccessAssignmentRole;
    created_by?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface ContentAccessGrant {
    id?: string;
    user_id?: string;
    email: string;
    role: AccessAssignmentRole;
    created_by?: string | null;
    created_at?: string;
    updated_at?: string;
    chat_id?: string;
    tabular_review_id?: string;
}

export interface ContentAccess {
    scope: "direct" | "project";
    inherited_from_project_id?: string;
    org_id: string | null;
    access_role: ProjectRole;
    grants: ContentAccessGrant[];
}

export interface ProjectAccess {
    scope: "direct" | "organization";
    org_id: string | null;
    /** The caller's own role, so the dialog knows whether to offer controls. */
    access_role: ProjectRole;
    grants: ProjectGrant[];
}

export async function getProjectAccess(
    projectId: string,
): Promise<ProjectAccess> {
    return apiRequest<ProjectAccess>(`/projects/${projectId}/access`);
}

/** Create or re-role one recipient (the endpoint upserts, so both are POST). */
export async function grantProjectAccess(
    projectId: string,
    email: string,
    role: AccessAssignmentRole,
): Promise<ProjectGrant> {
    return apiRequest<ProjectGrant>(`/projects/${projectId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
}

export async function revokeProjectAccess(
    projectId: string,
    email: string,
): Promise<void> {
    await apiRequest(
        `/projects/${projectId}/access/${encodeURIComponent(email)}`,
        { method: "DELETE" },
    );
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export interface Org {
    id: string;
    name: string;
    created_by: string | null;
    created_at?: string;
    updated_at?: string;
    /** The caller's role in this org. */
    role: OrgRole;
    can_access_private_content?: boolean;
    /**
     * When the organization's logo was last set, or null/absent for none. It
     * says whether there is a logo to fetch, and changes when the logo does.
     */
    logo_updated_at?: string | null;
    /** Accepted roster size, so a card can say "N members" without a fetch. */
    member_count?: number;
}

/**
 * Bare org_members row, as mutation endpoints return it (PATCH /members/:id
 * responds with the updated row — no profile enrichment).
 */
export interface OrgMemberRow {
    id: string;
    user_id: string;
    role: OrgRole;
    can_access_private_content?: boolean;
    created_at?: string;
}

/** Roster row from GET /members: the bare row plus mirrored profile fields. */
export interface OrgMember extends OrgMemberRow {
    profile_photo?: string | null;
    email: string | null;
    display_name: string | null;
}

/**
 * An invitation. Membership is only ever created by accepting one of these —
 * there is no endpoint that drops somebody into an organization full of
 * confidential material without their consent.
 *
 * `status` is reported lazily: a pending row past `expires_at` comes back as
 * "expired" without anything having written to it.
 */
export type OrgInvitationStatus =
    | "pending"
    | "accepted"
    | "declined"
    | "cancelled"
    | "expired";

export interface OrgInvitation {
    id: string;
    org_id: string;
    email: string;
    role: OrgRole;
    invited_by: string | null;
    status: OrgInvitationStatus;
    expires_at: string;
    created_at: string;
    accepted_at: string | null;
    declined_at: string | null;
    cancelled_at: string | null;
    /** Admin roster only. */
    invited_by_email?: string | null;
    /** Recipient list only — the recipient is not a member yet, so they
     *  cannot look the organization's name up any other way. */
    org_name?: string | null;
}

export async function listOrgs(): Promise<Org[]> {
    return apiRequest<Org[]>("/orgs");
}

export type { DeletedOrganization } from "@mike/contracts";

export async function listDeletedOrganizations(): Promise<import("@mike/contracts").DeletedOrganization[]> {
    return apiRequest("/orgs/deleted");
}

export async function restoreOrganization(orgId: string): Promise<void> {
    await apiRequest(`/orgs/${orgId}/restore`, { method: "POST" });
}

export async function createOrg(name: string): Promise<Org> {
    return apiRequest<Org>("/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export async function getOrg(orgId: string): Promise<Org> {
    return apiRequest<Org>(`/orgs/${orgId}`);
}

export async function updateOrg(orgId: string, name: string): Promise<Org> {
    return apiRequest<Org>(`/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

/** Soft-delete an organization for 30 days. Owner only. */
export async function deleteOrg(orgId: string): Promise<void> {
    await apiRequest(`/orgs/${orgId}`, { method: "DELETE" });
}

export type OrgDataKind = "chats" | "tabular-reviews" | "projects" | "memories";

/** Permanently deletes one kind of content across an organization. Owner only. */
export async function deleteOrgData(
    orgId: string,
    kind: OrgDataKind,
): Promise<void> {
    await apiRequest(`/orgs/${orgId}/data/${kind}`, { method: "DELETE" });
}

/**
 * The organization's logo as a data URL, or null when it has none. Shown in
 * the sidebar in place of the app's logo while its workspace is active.
 */
export async function getOrgLogo(orgId: string): Promise<string | null> {
    try {
        const logo = await apiRequest<{ data_url: string }>(
            `/orgs/${orgId}/logo`,
        );
        return logo.data_url || null;
    } catch (error) {
        if (error instanceof MikeApiError && error.status === 404) return null;
        throw error;
    }
}

/** Set or replace the logo, sent as a PNG, JPEG or WebP data URL. */
export async function saveOrgLogo(
    orgId: string,
    dataUrl: string,
): Promise<{ logo_updated_at: string }> {
    return apiRequest<{ logo_updated_at: string }>(`/orgs/${orgId}/logo`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data_url: dataUrl }),
    });
}

export async function deleteOrgLogo(orgId: string): Promise<void> {
    await apiRequest(`/orgs/${orgId}/logo`, { method: "DELETE" });
}

/**
 * An organization's model provider keys, as its members see them. Never a
 * key itself: only which providers are set up.
 */
export interface OrgApiKeySettings {
    /** The organization's own keys. */
    keys: ApiKeyStatus;
    /**
     * What the caller can run in the organization: its keys, with their own
     * beneath where that is allowed. The model picker reads this.
     */
    effective: ApiKeyStatus;
    /**
     * The models the organization's key may run, per "model list" provider.
     * Keyed by router slug; chosen by its owners and admins.
     */
    router_models: Record<string, string[]>;
    /**
     * The lists that govern the caller's work here: the organization's for
     * each provider whose key it holds, their own for the rest.
     */
    effective_router_models: Record<string, string[]>;
    /** Whether a member's own key is used where the organization has none. */
    allow_personal_api_keys: boolean;
    /** Whether the caller may change any of this (owners and admins). */
    can_manage: boolean;
}

export async function getOrgApiKeys(orgId: string): Promise<OrgApiKeySettings> {
    return apiRequest<OrgApiKeySettings>(`/orgs/${orgId}/api-keys`);
}

export async function saveOrgApiKey(
    orgId: string,
    provider: ApiKeyProvider,
    apiKey: string | null,
    settings?: ApiKeySettings[keyof ApiKeySettings],
): Promise<OrgApiKeySettings> {
    return apiRequest<OrgApiKeySettings>(
        `/orgs/${orgId}/api-keys/${provider}`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
                settings ? { api_key: apiKey, settings } : { api_key: apiKey },
            ),
        },
    );
}

/** Replace the models the organization's key for one provider may run. */
export async function saveOrgRouterModels(
    orgId: string,
    provider: ApiKeyProvider,
    modelIds: string[],
): Promise<OrgApiKeySettings> {
    return apiRequest<OrgApiKeySettings>(
        `/orgs/${orgId}/api-keys/${provider}/models`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model_ids: modelIds }),
        },
    );
}

export async function setOrgApiKeyEnabled(
    orgId: string,
    provider: ApiKeyProvider,
    enabled: boolean,
): Promise<OrgApiKeySettings> {
    return apiRequest<OrgApiKeySettings>(
        `/orgs/${orgId}/api-keys/${provider}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

export async function setOrgPersonalApiKeysAllowed(
    orgId: string,
    allowed: boolean,
): Promise<OrgApiKeySettings> {
    return apiRequest<OrgApiKeySettings>(`/orgs/${orgId}/api-keys/policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allow_personal_api_keys: allowed }),
    });
}

export async function listOrgMembers(orgId: string): Promise<OrgMember[]> {
    return apiRequest<OrgMember[]>(`/orgs/${orgId}/members`);
}

export type { OrgPrivateContentItem, OrgPrivateContentKind, OrgPrivateContentPage } from "@mike/contracts";

export async function listOrgPrivateContent(orgId: string, offset = 0, search = "") {
    const query = new URLSearchParams({ limit: "50", offset: String(offset), search });
    return apiRequest<import("@mike/contracts").OrgPrivateContentPage>(`/orgs/${orgId}/private-content?${query}`);
}

export async function setOrgPrivateContentPermission(orgId: string, userId: string, enabled: boolean): Promise<void> {
    await apiRequest(`/orgs/${orgId}/members/${userId}/private-content-permission`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
    });
}

export async function openOrgPrivateContent(orgId: string, kind: import("@mike/contracts").OrgPrivateContentKind, itemId: string): Promise<void> {
    await apiRequest(`/orgs/${orgId}/private-content/${kind}/${itemId}/open`, { method: "POST" });
}

export async function closeOrgPrivateContent(orgId: string, kind: import("@mike/contracts").OrgPrivateContentKind, itemId: string): Promise<void> {
    await apiRequest(`/orgs/${orgId}/private-content/${kind}/${itemId}`, { method: "DELETE" });
}

export async function updateOrgMember(
    orgId: string,
    userId: string,
    role: OrgRole,
): Promise<OrgMemberRow> {
    return apiRequest<OrgMemberRow>(`/orgs/${orgId}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
    });
}

/** Asked before removing a member, or before leaving (the caller's own id). */
export async function getOrgMemberHandover(
    orgId: string,
    userId: string,
    departingUserIds?: string[],
): Promise<OrgMemberHandover> {
    const query = departingUserIds?.length
        ? `?${new URLSearchParams({ departing_user_ids: departingUserIds.join(",") })}`
        : "";
    return apiRequest<OrgMemberHandover>(
        `/orgs/${orgId}/members/${userId}/handover${query}`,
    );
}

/**
 * Remove a member, or leave (the caller's own id). `assignTo` names the
 * member who takes over shared work. If omitted, the server selects a
 * remaining organization owner. Unshared work is archived for 30 days.
 */
export async function removeOrgMember(
    orgId: string,
    userId: string,
    assignTo?: string,
): Promise<void> {
    const query = assignTo
        ? `?${new URLSearchParams({ assign_to: assignTo }).toString()}`
        : "";
    await apiRequest(`/orgs/${orgId}/members/${userId}${query}`, {
        method: "DELETE",
    });
}

/** Owner-only: private work left by departed members, by departure. */
export function listOrgDepartures(orgId: string): Promise<OrgDepartureList> {
    return apiRequest(`/orgs/${orgId}/departures`);
}

/** Hands archived items to a member, who becomes their owner. */
export function reassignOrgDepartureArchives(
    orgId: string,
    archiveIds: string[],
    assignTo: string,
): Promise<OrgDepartureResolution> {
    return apiRequest(`/orgs/${orgId}/archives/recover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive_ids: archiveIds, assign_to: assignTo }),
    });
}

/** Permanently deletes archived items with their contents. */
export function deleteOrgDepartureArchives(
    orgId: string,
    archiveIds: string[],
): Promise<OrgDepartureResolution> {
    return apiRequest(`/orgs/${orgId}/archives/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archive_ids: archiveIds }),
    });
}

// --- Invitations: the admin's side ---------------------------------------

export async function listOrgInvitations(
    orgId: string,
): Promise<OrgInvitation[]> {
    return apiRequest<OrgInvitation[]>(`/orgs/${orgId}/invitations`);
}

export async function createOrgInvitation(
    orgId: string,
    email: string,
    role: InvitableOrgRole,
): Promise<OrgInvitation> {
    return apiRequest<OrgInvitation>(`/orgs/${orgId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
}

export async function cancelOrgInvitation(
    orgId: string,
    invitationId: string,
): Promise<void> {
    await apiRequest(`/orgs/${orgId}/invitations/${invitationId}`, {
        method: "DELETE",
    });
}

export async function resendOrgInvitation(
    orgId: string,
    invitationId: string,
): Promise<OrgInvitation> {
    return apiRequest<OrgInvitation>(
        `/orgs/${orgId}/invitations/${invitationId}/resend`,
        { method: "POST" },
    );
}

// --- Invitations: the recipient's side ------------------------------------
//
// These hang off /user, not /orgs: the caller is not a member yet, so an
// org-scoped route would have to answer "which org?" before it could answer
// "are you allowed to know?". Matching is by the account's email, which is
// what lets an invitation sent before signup be claimed once the account
// exists.

export async function listMyOrgInvitations(): Promise<OrgInvitation[]> {
    return apiRequest<OrgInvitation[]>("/user/invitations");
}

export async function acceptOrgInvitation(
    invitationId: string,
): Promise<{ org_id: string; role: OrgRole }> {
    return apiRequest<{ org_id: string; role: OrgRole }>(
        `/user/invitations/${invitationId}/accept`,
        { method: "POST" },
    );
}

export async function declineOrgInvitation(
    invitationId: string,
): Promise<void> {
    await apiRequest(`/user/invitations/${invitationId}/decline`, {
        method: "POST",
    });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export type FolderConflictResolution = "error" | "reuse" | "rename";

export type FolderPathResolution<TFolder> =
    | {
          conflict: true;
          folder_name: string;
          existing_folder_id: string;
          suggested_name: string;
      }
    | {
          conflict: false;
          folder_id: string;
          resolved_name: string;
          folders: TFolder[];
      };

export async function resolveProjectFolderPath(
    projectId: string,
    segments: string[],
    baseFolderId: string | null,
    conflictResolution: FolderConflictResolution = "error",
): Promise<FolderPathResolution<Folder>> {
    return apiRequest<FolderPathResolution<Folder>>(
        `/projects/${projectId}/folder-paths/resolve`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                segments,
                base_folder_id: baseFolderId,
                conflict_resolution: conflictResolution,
            }),
        },
    );
}

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_folder_id: parentFolderId }),
    });
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function renameProjectDocument(
    projectId: string,
    documentId: string,
    filename: string,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export type LibraryKind = "files" | "templates";

export interface LibraryCollection {
    documents: Document[];
    folders: LibraryFolder[];
    documentsHasMore: boolean;
}

interface LibraryPagination {
    limit?: number;
    offset?: number;
}

interface LibrarySearchParams extends LibraryPagination {
    search?: string;
    fileType?: string;
    sortKey?: "name" | "type" | "size" | "version" | "created" | "updated";
    sortDirection?: "asc" | "desc";
    signal?: AbortSignal;
}

interface LibrarySearchResults {
    documents: Document[];
    documentsHasMore: boolean;
}

/**
 * Which library a call is about. The library is per workspace — a person's
 * own documents and folders in Personal, and their own in each organization
 * they belong to — so a call that lists, or files into, one of them names it:
 * `{ kind, workspace }`, with `workspace` "personal" or an organization id.
 * A bare kind names no workspace, and is not narrowed.
 */
export type LibraryScope =
    | LibraryKind
    | { kind: LibraryKind; workspace?: string };

function libraryKindOf(scope: LibraryScope): LibraryKind {
    return typeof scope === "string" ? scope : scope.kind;
}

function libraryWorkspaceOf(scope: LibraryScope): string | undefined {
    return typeof scope === "string" ? undefined : scope.workspace;
}

/** `org_id` for an upload made in `workspace`: none in Personal. */
function workspaceOrgId(workspace: string | undefined): string | undefined {
    return workspace && workspace !== "personal" ? workspace : undefined;
}

/** A library route, with the scope's workspace on the query string. */
function libraryUrl(
    scope: LibraryScope,
    suffix = "",
    params: URLSearchParams = new URLSearchParams(),
): string {
    const workspace = libraryWorkspaceOf(scope);
    if (workspace) params.set("workspace", workspace);
    const qs = params.toString();
    return `/library/${libraryKindOf(scope)}${suffix}${qs ? `?${qs}` : ""}`;
}

function libraryPaginationParams(
    pagination?: LibraryPagination,
): URLSearchParams {
    const params = new URLSearchParams();
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    return params;
}

export async function getLibrary(
    kind: LibraryScope,
    pagination?: LibraryPagination,
): Promise<LibraryCollection> {
    return apiRequest<LibraryCollection>(
        libraryUrl(kind, "", libraryPaginationParams(pagination)),
    );
}

export async function getLibraryFolderChildren(
    kind: LibraryScope,
    folderId: string,
    pagination?: LibraryPagination,
): Promise<LibraryCollection> {
    const params = new URLSearchParams({ parent_folder_id: folderId });
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    return apiRequest<LibraryCollection>(libraryUrl(kind, "", params));
}

export async function getLibraryFolderPath(
    kind: LibraryScope,
    folderId: string,
): Promise<{ folders: LibraryFolder[] }> {
    return apiRequest<{ folders: LibraryFolder[] }>(
        libraryUrl(kind, `/folders/${folderId}`),
    );
}

export async function getLibraryLevels(
    kind: LibraryScope,
    levels: { parentId: string | null; limit: number }[],
): Promise<{
    levels: Array<LibraryCollection & { parentId: string | null }>;
}> {
    return apiRequest(libraryUrl(kind, "/levels"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ levels }),
    });
}

export async function searchLibraryDocuments(
    kind: LibraryScope,
    options: LibrarySearchParams,
): Promise<LibrarySearchResults> {
    const params = new URLSearchParams({ view: "search" });
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.offset != null) params.set("offset", String(options.offset));
    if (options.search) params.set("search", options.search);
    if (options.fileType) params.set("file_type", options.fileType);
    if (options.sortKey) params.set("sort_key", options.sortKey);
    if (options.sortDirection)
        params.set("sort_direction", options.sortDirection);
    return apiRequest<LibrarySearchResults>(libraryUrl(kind, "", params), {
        signal: options.signal,
    });
}

export async function getLibraryFilterOptions(
    kind: LibraryScope,
): Promise<{ fileTypes: string[] }> {
    return apiRequest<{ fileTypes: string[] }>(
        libraryUrl(kind, "/filter-options"),
    );
}

export async function listLibraryDocumentIds(
    kind: LibraryScope,
    options?: { search?: string; fileType?: string; signal?: AbortSignal },
): Promise<string[]> {
    const params = new URLSearchParams();
    if (options?.search) params.set("search", options.search);
    if (options?.fileType) params.set("file_type", options.fileType);
    return apiRequest<string[]>(libraryUrl(kind, "/ids", params), {
        signal: options?.signal,
    });
}

export async function bulkDeleteLibraryDocuments(
    kind: LibraryScope,
    ids: string[],
): Promise<{ deletedIds: string[] }> {
    return apiRequest<{ deletedIds: string[] }>(
        libraryUrl(kind, "/documents/bulk-delete"),
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
        },
    );
}

export async function uploadLibraryDocument(
    kind: LibraryScope,
    file: File,
    folderId?: string | null,
    options?: UploadRequestOptions<Document>,
): Promise<Document> {
    return firstUploadResult(
        await uploadLibraryDocuments(kind, [{ file, folderId }], options),
    );
}

export async function uploadLibraryDocuments(
    kind: LibraryScope,
    files: UploadSessionInput[],
    options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
    return uploadFilesWithSession<Document>({
        purpose: "document_create",
        destination: {
            scope: "library",
            library_kind: libraryKindOf(kind) === "files" ? "file" : "template",
            // Filed under the workspace it is uploaded in; Personal has none.
            ...(workspaceOrgId(libraryWorkspaceOf(kind))
                ? { org_id: workspaceOrgId(libraryWorkspaceOf(kind)) }
                : {}),
        },
        files,
        onProgress: options?.onProgress,
        signal: options?.signal,
    });
}

export async function createLibraryFolder(
    kind: LibraryScope,
    name: string,
    parentFolderId?: string | null,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(libraryUrl(kind, "/folders"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function resolveLibraryFolderPath(
    kind: LibraryScope,
    segments: string[],
    baseFolderId: string | null,
    conflictResolution: FolderConflictResolution = "error",
): Promise<FolderPathResolution<LibraryFolder>> {
    return apiRequest<FolderPathResolution<LibraryFolder>>(
        libraryUrl(kind, "/folder-paths/resolve"),
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                segments,
                base_folder_id: baseFolderId,
                conflict_resolution: conflictResolution,
            }),
        },
    );
}

export async function renameLibraryFolder(
    kind: LibraryScope,
    folderId: string,
    name: string,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(
        libraryUrl(kind, `/folders/${folderId}`),
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
        },
    );
}

export async function deleteLibraryFolder(
    kind: LibraryScope,
    folderId: string,
): Promise<void> {
    await apiRequest(libraryUrl(kind, `/folders/${folderId}`), {
        method: "DELETE",
    });
}

export async function moveLibraryFolder(
    kind: LibraryScope,
    folderId: string,
    parentFolderId: string | null,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(
        libraryUrl(kind, `/folders/${folderId}`),
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parent_folder_id: parentFolderId }),
        },
    );
}

export async function moveLibraryDocument(
    kind: LibraryScope,
    documentId: string,
    folderId: string | null,
): Promise<Document> {
    return apiRequest<Document>(
        libraryUrl(kind, `/documents/${documentId}/folder`),
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function renameLibraryDocument(
    kind: LibraryScope,
    documentId: string,
    filename: string,
): Promise<Document> {
    return apiRequest<Document>(
        libraryUrl(kind, `/documents/${documentId}`),
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface DocumentVersion {
    id: string;
    version_number: number | null;
    source: string;
    created_at: string;
    filename: string | null;
    file_type?: string | null;
    size_bytes?: number | null;
    page_count?: number | null;
    textless_page_count?: number | null;
    deleted_at?: string | null;
    deleted_by?: string | null;
}

export async function listDocumentVersions(documentId: string): Promise<{
    current_version_id: string | null;
    versions: DocumentVersion[];
}> {
    return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    filename?: string,
    options?: UploadRequestOptions<DocumentVersion>,
): Promise<DocumentVersion> {
    return firstUploadResult(
        await uploadFilesWithSession<DocumentVersion>({
            purpose: "document_version_create",
            destination: { document_id: documentId, filename },
            files: [{ file }],
            onProgress: options?.onProgress,
            signal: options?.signal,
        }),
    );
}

export async function replaceDocumentVersionFile(
    documentId: string,
    versionId: string,
    file: File,
    filename?: string,
    options?: UploadRequestOptions<DocumentVersion> & {
        expectedContentSha256?: string;
        /** Skip eager PDF generation for frequent editor saves. */
        generatePdf?: boolean;
    },
): Promise<DocumentVersion> {
    const uploadedFile = filename
        ? new File([file], filename, {
              type: file.type,
              lastModified: file.lastModified,
          })
        : file;
    return firstUploadResult(
        await uploadFilesWithSession<DocumentVersion>({
            purpose: "document_version_replace",
            destination: {
                document_id: documentId,
                version_id: versionId,
                ...(options?.expectedContentSha256
                    ? { expected_content_sha256: options.expectedContentSha256 }
                    : {}),
                ...(options?.generatePdf !== undefined
                    ? { generate_pdf: options.generatePdf }
                    : {}),
            },
            files: [{ file: uploadedFile }],
            onProgress: options?.onProgress,
            signal: options?.signal,
        }),
    );
}

export async function copyDocumentVersionFromDocument(
    documentId: string,
    sourceDocumentId: string,
    filename?: string,
): Promise<DocumentVersion> {
    return apiRequest<DocumentVersion>(
        `/single-documents/${documentId}/versions/from-document`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_document_id: sourceDocumentId,
                filename,
            }),
        },
    );
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    filename: string | null,
): Promise<DocumentVersion> {
    return apiRequest<DocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export async function deleteDocumentVersion(
    documentId: string,
    versionId: string,
): Promise<{
    deleted_version_id: string;
    current_version_id: string | null;
}> {
    return apiRequest(`/single-documents/${documentId}/versions/${versionId}`, {
        method: "DELETE",
    });
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
    folderId?: string | null,
    options?: UploadRequestOptions<Document>,
): Promise<Document> {
    return firstUploadResult(
        await uploadProjectDocuments(projectId, [{ file, folderId }], options),
    );
}

export async function uploadProjectDocuments(
    projectId: string,
    files: UploadSessionInput[],
    options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
    return uploadFilesWithSession<Document>({
        purpose: "document_create",
        destination: { scope: "project", project_id: projectId },
        files,
        onProgress: options?.onProgress,
        signal: options?.signal,
    });
}

/**
 * Upload documents on their own — attached to a chat, outside any project.
 * `workspace` is the workspace they are uploaded in ("personal" or an
 * organization id): a document uploaded in an organization's workspace
 * belongs to that organization.
 */
export async function uploadStandaloneDocument(
    file: File,
    options?: UploadRequestOptions<Document>,
    workspace?: string,
): Promise<Document> {
    return firstUploadResult(
        await uploadStandaloneDocuments([{ file }], options, workspace),
    );
}

export async function uploadStandaloneDocuments(
    files: UploadSessionInput[],
    options?: UploadRequestOptions<Document>,
    workspace?: string,
): Promise<UploadOutcome<Document>[]> {
    const orgId = workspaceOrgId(workspace);
    return uploadFilesWithSession<Document>({
        purpose: "document_create",
        destination: {
            scope: "standalone",
            ...(orgId ? { org_id: orgId } : {}),
        },
        files,
        onProgress: options?.onProgress,
        signal: options?.signal,
    });
}

export async function getDocument(documentId: string): Promise<Document> {
    return apiRequest<Document>(`/single-documents/${documentId}`);
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

interface DocumentEditResolution {
    ok: boolean;
    already_resolved?: boolean;
    status?: "accepted" | "rejected";
    version_id: string | null;
    download_url: string | null;
    remaining_pending?: number;
}

export async function resolveDocumentEdit(
    documentId: string,
    editId: string,
    verb: "accept" | "reject",
): Promise<DocumentEditResolution> {
    return apiRequest<DocumentEditResolution>(
        `/single-documents/${encodeURIComponent(documentId)}/edits/${encodeURIComponent(editId)}/${verb}`,
        { method: "POST" },
    );
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

function documentFilePath(
    documentId: string,
    versionId?: string | null,
): string {
    const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    return `/single-documents/${encodeURIComponent(documentId)}/file${qs}`;
}

export function getDocumentFileUrl(
    documentId: string,
    versionId?: string | null,
): string {
    return `${API_BASE}${documentFilePath(documentId, versionId)}`;
}

export async function getDocumentFile(
    documentId: string,
    versionId?: string | null,
): Promise<{ blob: Blob; filename: string | null }> {
    return apiBlobRequest(documentFilePath(documentId, versionId));
}

export async function downloadDocumentsZip(
    documentIds: string[],
    folderIds: string[] = [],
): Promise<Blob> {
    const response = await apiFetch(
        `${API_BASE}/single-documents/download-zip`,
        {
            method: "POST",
            cache: "no-store",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                document_ids: documentIds,
                folder_ids: folderIds,
            }),
        },
    );
    if (!response.ok) {
        throw await toApiError(response, "/single-documents/download-zip");
    }
    return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
    /**
     * The organization whose workspace a standalone chat is started in.
     * Omitted in Personal; not consulted when the chat is in a project.
     */
    org_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(options?: {
    limit?: number;
    offset?: number;
    beforeUpdatedAt?: string;
    beforeId?: string;
    workspace?: string;
}): Promise<Chat[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    if (options?.beforeUpdatedAt)
        params.set("before_updated_at", options.beforeUpdatedAt);
    if (options?.beforeId) params.set("before_id", options.beforeId);
    if (options?.workspace) params.set("workspace", options.workspace);
    const query = params.toString();
    return apiRequest<Chat[]>(`/chat${query ? `?${query}` : ""}`);
}

export async function listProjectChats(projectId: string): Promise<Chat[]> {
    return apiRequest<Chat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<ChatDetailOut> {
    const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
    const messages: Message[] = raw.messages.map((m) => {
        if (m.role === "user") {
            return {
                id: m.id,
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            id: m.id,
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            citations: m.citations ?? undefined,
            events,
        };
    });
    return {
        // Fold the caller's served standing into the row so consumers gate
        // with roleFrom(chat) exactly as list surfaces do. Dropping these
        // fields is how the global chat page ended up handing a project
        // viewer a fully writable composer whose sends 403.
        chat: {
            ...raw.chat,
            is_owner: raw.is_owner,
            access_role: raw.access_role,
        },
        messages,
        active_turn: raw.active_turn ?? null,
    };
}

/**
 * Attach to a turn the server is generating (or has just finished) for this
 * chat. Frames with a sequence number >= `from` are replayed, then the live
 * ones follow until the turn ends. `from` is the id of the last frame the
 * caller saw plus one; 1 means everything.
 */
export async function streamChatTurn(payload: {
    chatId: string;
    turnId: string;
    from?: number;
    signal?: AbortSignal;
}): Promise<Response> {
    const { chatId, turnId, from = 1, signal } = payload;
    return apiFetch(
        `${API_BASE}/chat/${chatId}/turn/${turnId}/stream?from=${from}`,
        { headers: { Accept: "text/event-stream" }, signal },
    );
}

/**
 * The one way to cut a generation short. Closing the stream only detaches
 * this client; the server keeps generating for everyone else.
 */
export async function stopChatTurn(
    chatId: string,
    turnId: string,
): Promise<{ stopped: boolean; finished: boolean }> {
    return apiRequest<{ stopped: boolean; finished: boolean }>(
        `/chat/${chatId}/turn/${turnId}/stop`,
        { method: "POST" },
    );
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function updateChatModel(
    chatId: string,
    model: string,
): Promise<{ id: string; title: string | null; model: string }> {
    return apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        keepalive: true,
    });
}

export async function updateChatReasoningLevel(
    chatId: string,
    reasoningLevel: NonNullable<Message["reasoning"]>,
): Promise<{
    id: string;
    title: string | null;
    model: string;
    reasoning_level: NonNullable<Message["reasoning"]>;
}> {
    return apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningLevel }),
        keepalive: true,
    });
}

export async function getChatPeople(chatId: string): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/chat/${chatId}/people`);
}

export async function getChatAccess(chatId: string): Promise<ContentAccess> {
    return apiRequest<ContentAccess>(`/chat/${chatId}/access`);
}

export async function grantChatAccess(
    chatId: string,
    email: string,
    role: AccessAssignmentRole,
): Promise<ContentAccessGrant> {
    return apiRequest<ContentAccessGrant>(`/chat/${chatId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
}

export async function revokeChatAccess(
    chatId: string,
    email: string,
): Promise<void> {
    await apiRequest(`/chat/${chatId}/access/${encodeURIComponent(email)}`, {
        method: "DELETE",
    });
}

export async function updateLastSelectedChatSettings(payload: {
    lastSelectedChatModel?: string;
    lastSelectedReasoningLevel?: NonNullable<Message["reasoning"]>;
}): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
    });
}

export async function leaveChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}/leave`, { method: "POST" });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

const panelDocumentRequests = new Map<string, Promise<PanelDocument>>();

export async function getPanelDocument(
    documentId: string,
): Promise<PanelDocument> {
    let request = panelDocumentRequests.get(documentId);
    if (!request) {
        request = apiRequest<unknown>(
            `/documents/${encodeURIComponent(documentId)}`,
        )
            .then((value) => {
                if (!isPanelDocument(value)) {
                    throw new Error("Invalid source document response");
                }
                return value;
            })
            .finally(() => panelDocumentRequests.delete(documentId));
        panelDocumentRequests.set(documentId, request);
    }
    return request;
}

/**
 * The browser's IANA time zone (e.g. "Europe/London"), sent with chat requests
 * so the assistant knows the user's local date and time.
 */
function browserTimeZone(): string | undefined {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
        return undefined;
    }
}

export async function streamChat(payload: {
    messages: {
        role: string;
        content: string;
        files?: MessageFile[];
        workflow?: { id: string; title: string };
    }[];
    chat_id?: string;
    project_id?: string;
    /**
     * The organization whose workspace the chat is in. It decides where a
     * NEW chat is filed; an existing chat keeps the organization it has.
     */
    org_id?: string;
    model?: string;
    reasoning?: Message["reasoning"];
    ask_inputs_response?: AskInputsResponsePayload;
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...body } = payload;
    return apiFetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify({ ...body, time_zone: browserTimeZone() }),
        signal,
    });
}

type StreamChatMessage = {
    role: string;
    content: string;
    files?: MessageFile[];
    workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
    projectId: string;
    messages: StreamChatMessage[];
    chat_id?: string;
    model?: string;
    reasoning?: Message["reasoning"];
    displayed_doc?: { filename: string; document_id: string };
    attached_documents?: { filename: string; document_id: string }[];
    ask_inputs_response?: AskInputsResponsePayload;
    signal?: AbortSignal;
}): Promise<Response> {
    const { projectId, signal, ...body } = payload;
    return apiFetch(`${API_BASE}/projects/${projectId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
        },
        body: JSON.stringify({ ...body, time_zone: browserTimeZone() }),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
    pagination?: {
        limit?: number;
        offset?: number;
        search?: string;
        sortKey?: string;
        sortDirection?: "asc" | "desc";
        scope?: "all" | "in-project" | "standalone";
        workspace?: string;
        includeStatus?: boolean;
        ownerUserId?: string;
        signal?: AbortSignal;
    },
): Promise<TabularReview[]> {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);
    if (pagination?.workspace) params.set("workspace", pagination.workspace);
    if (pagination?.includeStatus) params.set("include", "status");
    if (pagination?.ownerUserId)
        params.set("owner_user_id", pagination.ownerUserId);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`, {
        signal: pagination?.signal,
    });
}

export async function getTabularReviewHistoryStatuses(
    ids: string[],
    signal?: AbortSignal,
): Promise<TabularReviewHistoryStatus[]> {
    const params = new URLSearchParams({ ids: ids.join(",") });
    return apiRequest(`/tabular-review/history-status?${params}`, { signal });
}

export async function listTabularReviewIds(
    projectId?: string,
    options?: {
        search?: string;
        scope?: "all" | "in-project" | "standalone";
        workspace?: string;
        ownerUserId?: string;
        signal?: AbortSignal;
    },
): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    if (options?.workspace) params.set("workspace", options.workspace);
    if (options?.ownerUserId) params.set("owner_user_id", options.ownerUserId);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(
        `/tabular-review/ids${qs}`,
        { signal: options?.signal },
    );
}

/** Everyone who created a review in a project, for its Creator filter. */
export async function listProjectReviewCreators(
    projectId: string,
    signal?: AbortSignal,
): Promise<AuditActor[]> {
    const params = new URLSearchParams({ project_id: projectId });
    return apiRequest(`/tabular-review/creators?${params}`, { signal });
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
    /**
     * The organization whose workspace a standalone review is started in.
     * Omitted in Personal; not consulted when the review is in a project.
     */
    org_id?: string;
    document_grouping?: "document" | "folder";
    model: string;
}): Promise<TabularReview> {
    const review = await apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    notifyTabularReviewsChanged();
    return review;
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        document_grouping?: "document" | "folder";
        model?: string;
    },
): Promise<TabularReview> {
    const review = await apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    notifyTabularReviewsChanged();
    return review;
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function getTabularReviewAccess(
    reviewId: string,
): Promise<ContentAccess> {
    return apiRequest<ContentAccess>(`/tabular-review/${reviewId}/access`);
}

export async function grantTabularReviewAccess(
    reviewId: string,
    email: string,
    role: AccessAssignmentRole,
): Promise<ContentAccessGrant> {
    return apiRequest<ContentAccessGrant>(
        `/tabular-review/${reviewId}/access`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, role }),
        },
    );
}

export async function revokeTabularReviewAccess(
    reviewId: string,
    email: string,
): Promise<void> {
    await apiRequest(
        `/tabular-review/${reviewId}/access/${encodeURIComponent(email)}`,
        { method: "DELETE" },
    );
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
    return apiRequest<{
        prompt: string;
        source: "preset" | "llm" | "fallback";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        /**
         * The review's workspace, for a review outside any project: the file
         * is filed there, because a review takes documents from its own
         * workspace only.
         */
        workspace?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<Document> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file, undefined, options?.workspace);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
    notifyTabularReviewsChanged();
}

export async function streamTabularGeneration(
    reviewId: string,
    expectedUpdatedAt: string,
    signal?: AbortSignal,
): Promise<Response> {
    return apiFetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expected_updated_at: expectedUpdatedAt }),
        signal,
    });
}

/**
 * Reconnect to a generation that is already running (GET, not POST): a pure
 * observer that takes no generation lease and enqueues nothing, so resuming a
 * run can never 409 or restart it. Used when a stream drops mid-run and when
 * the view mounts on a review that is already `is_running`.
 *
 * `from` is the sequence number to replay from — the last `id:` seen plus one
 * — so a reconnect picks up where it left off instead of replaying the whole
 * run. A server with no in-process run ignores it and tails the database.
 */
export async function streamTabularGenerationResume(
    reviewId: string,
    signal?: AbortSignal,
    from?: number,
): Promise<Response> {
    const query = from ? `?from=${from}` : "";
    return apiFetch(
        `${API_BASE}/tabular-review/${reviewId}/generate/stream${query}`,
        { signal: signal ?? undefined },
    );
}

/**
 * Stop a generation the server is running. Closing the SSE socket no longer
 * cancels anything, so this is the Stop control's only lever. A deployment
 * whose extraction runs on the queue — or a run owned by another replica —
 * has nothing in-process to stop and answers 404 `generation_not_found`.
 */
export async function stopTabularGeneration(
    reviewId: string,
): Promise<{ stopped: boolean; finished: boolean }> {
    return apiRequest(`/tabular-review/${reviewId}/generate/stop`, {
        method: "POST",
    });
}

export async function streamTabularChat(
    reviewId: string,
    messages: { role: string; content: string }[],
    chat_id?: string | null,
    signal?: AbortSignal,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    model?: Message["model"],
    reasoning?: Message["reasoning"],
): Promise<Response> {
    return apiFetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            messages,
            chat_id: chat_id ?? undefined,
            review_title: context?.reviewTitle ?? undefined,
            project_name: context?.projectName ?? undefined,
            model,
            reasoning,
            time_zone: browserTimeZone(),
        }),
        signal: signal ?? undefined,
    });
}

/**
 * Attach to a review-chat turn the server is generating (or has just
 * finished). Frames with a sequence number >= `from` are replayed, then the
 * live ones follow until the turn ends; `from` is the last frame the caller
 * saw plus one, and 1 means everything.
 */
export async function streamTabularChatTurn(payload: {
    reviewId: string;
    chatId: string;
    turnId: string;
    from?: number;
    signal?: AbortSignal;
}): Promise<Response> {
    const { reviewId, chatId, turnId, from = 1, signal } = payload;
    return apiFetch(
        `${API_BASE}/tabular-review/${reviewId}/chats/${chatId}/turn/${turnId}/stream?from=${from}`,
        { headers: { Accept: "text/event-stream" }, signal },
    );
}

/**
 * The one way to cut a review-chat answer short. Closing the stream only
 * detaches this client; the server keeps generating for everyone else.
 */
export async function stopTabularChatTurn(
    reviewId: string,
    chatId: string,
    turnId: string,
): Promise<{ stopped: boolean; finished: boolean }> {
    return apiRequest<{ stopped: boolean; finished: boolean }>(
        `/tabular-review/${reviewId}/chats/${chatId}/turn/${turnId}/stop`,
        { method: "POST" },
    );
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

interface RawTRMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    annotations?: TRCitationAnnotation[] | null;
    created_at: string;
}

interface TRDisplayMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

export interface TRChat {
    id: string;
    title: string | null;
    model: string | null;
    reasoning_level: NonNullable<Message["reasoning"]> | null;
    created_at: string;
    updated_at: string;
    /**
     * Set while the server is still generating an answer into this thread. A
     * panel that has just loaded (a refresh, a second tab, a thread opened
     * from the list while its answer runs elsewhere) attaches to it instead
     * of showing a transcript whose last answer is simply missing.
     */
    active_turn?: ActiveAssistantTurn | null;
}

const TABULAR_CHAT_SELECTION_PREFIX = "tabular-review-chat:";

export function tabularChatSelectionKey(
    reviewId: string,
    chatId: string,
): string {
    return `${TABULAR_CHAT_SELECTION_PREFIX}${reviewId}:${chatId}`;
}

export function parseTabularChatSelectionKey(
    selectionKey: string,
): { reviewId: string; chatId: string } | null {
    if (!selectionKey.startsWith(TABULAR_CHAT_SELECTION_PREFIX)) return null;
    const value = selectionKey.slice(TABULAR_CHAT_SELECTION_PREFIX.length);
    const separatorIndex = value.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
    return {
        reviewId: value.slice(0, separatorIndex),
        chatId: value.slice(separatorIndex + 1),
    };
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
    return raw.map((m) => {
        if (m.role === "user") {
            return {
                role: "user" as const,
                content: typeof m.content === "string" ? m.content : "",
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        const content =
            events
                ?.filter((e) => e.type === "content")
                .map((e) => (e as { type: "content"; text: string }).text)
                .join("") ?? "";
        return {
            role: "assistant" as const,
            content,
            events,
            annotations: m.annotations ?? undefined,
        };
    });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<RawTRMessage[]> {
    return apiRequest<RawTRMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function renameTabularChat(
    reviewId: string,
    chatId: string,
    title: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function updateTabularChatModel(
    reviewId: string,
    chatId: string,
    model: string,
): Promise<TRChat> {
    return apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        keepalive: true,
    });
}

export async function updateTabularChatReasoningLevel(
    reviewId: string,
    chatId: string,
    reasoningLevel: NonNullable<Message["reasoning"]>,
): Promise<TRChat> {
    return apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasoningLevel }),
        keepalive: true,
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    rowId: string,
    columnIndex: number,
): Promise<
    | {
          summary: string;
          flag: "green" | "grey" | "yellow" | "red";
          reasoning: string;
      }
    // HTTP 202 — regeneration continues in the background
    | { status: "generating" }
> {
    const result = await apiRequest<Awaited<ReturnType<typeof regenerateTabularCell>>>(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            row_id: rowId,
            column_index: columnIndex,
        }),
    });
    notifyTabularReviewsChanged();
    return result;
}

export async function clearTabularCells(
    reviewId: string,
    rowIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_ids: rowIds }),
    });
    notifyTabularReviewsChanged();
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = Workflow["metadata"]["type"];

export async function listWorkflows(type?: WorkflowType, workspace?: string): Promise<Workflow[]> {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (workspace) params.set("workspace", workspace);
    const query = params.toString();
    return apiRequest<Workflow[]>(`/workflows${query ? `?${query}` : ""}`);
}

// The table uses reduced, paginated records. Pickers use listWorkflows(), whose
// workspace-only filter keeps instructions and tabular columns in the response.
export async function listWorkflowsPage(pagination?: {
    limit?: number;
    offset?: number;
    search?: string;
    sortKey?: string;
    sortDirection?: "asc" | "desc";
    scope?:
        | "all"
        | "owned"
        | "shared"
        | "private"
        | "collaborative"
        | "public"
        | "nonpublic";
    type?: WorkflowType;
    practice?: string;
    language?: string;
    jurisdiction?: string;
    workspace?: string;
    signal?: AbortSignal;
}): Promise<Workflow[]> {
    const params = new URLSearchParams();
    if (pagination?.type) params.set("type", pagination.type);
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);
    if (pagination?.practice) params.set("practice", pagination.practice);
    if (pagination?.language) params.set("language", pagination.language);
    if (pagination?.jurisdiction)
        params.set("jurisdiction", pagination.jurisdiction);
    if (pagination?.workspace) params.set("workspace", pagination.workspace);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<Workflow[]>(`/workflows${qs}`, {
        signal: pagination?.signal,
    });
}

export async function listWorkflowIds(options?: {
    search?: string;
    scope?:
        | "all"
        | "owned"
        | "shared"
        | "private"
        | "collaborative"
        | "public"
        | "nonpublic";
    type?: WorkflowType;
    practice?: string;
    language?: string;
    jurisdiction?: string;
    workspace?: string;
    signal?: AbortSignal;
}): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    if (options?.practice) params.set("practice", options.practice);
    if (options?.language) params.set("language", options.language);
    if (options?.jurisdiction) params.set("jurisdiction", options.jurisdiction);
    if (options?.workspace) params.set("workspace", options.workspace);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(
        `/workflows/ids${qs}`,
        {
            signal: options?.signal,
        },
    );
}

// Always-unpaginated: the static, code-generated system-workflow list (37
// entries, zero user-data growth). Fetched once by usePaginatedWorkflows and
// kept fully in memory rather than folded into the paginated RPC above.
export async function listSystemWorkflows(
    type?: WorkflowType,
): Promise<Workflow[]> {
    const qs = type ? `?type=${type}` : "";
    return apiRequest<Workflow[]>(`/workflows/system${qs}`);
}

export interface WorkflowFilterOptions {
    practices: string[];
    languages: string[];
    jurisdictions: string[];
}

export async function getWorkflowFilterOptions(options?: {
    type?: WorkflowType;
    scope?: "all" | "owned" | "shared";
    workspace?: string;
    signal?: AbortSignal;
}): Promise<WorkflowFilterOptions> {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    if (options?.workspace) params.set("workspace", options.workspace);
    const query = params.toString();
    return apiRequest<WorkflowFilterOptions>(
        `/workflows/filter-options${query ? `?${query}` : ""}`,
        {
            signal: options?.signal,
        },
    );
}

export async function getWorkflow(workflowId: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    metadata: {
        title: string;
        type: "assistant" | "tabular";
        language?: string | null;
        practice?: string | null;
        jurisdictions?: string[] | null;
    };
    skill_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
    org_id?: string;
    visibility?: ContentVisibility;
}): Promise<Workflow> {
    return apiRequest<Workflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        metadata?: {
            title?: string;
            language?: string | null;
            practice?: string | null;
            jurisdictions?: string[] | null;
        };
        skill_md?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        visibility?: ContentVisibility;
    },
): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

export async function openSourceWorkflow(
    workflowId: string,
    payload: {
        contributor_mode: OpenSourceWorkflowContributorMode;
        contributor?: WorkflowContributor | null;
    },
): Promise<OpenSourceWorkflowResponse> {
    return apiRequest<OpenSourceWorkflowResponse>(
        `/workflows/${workflowId}/open-source`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; role: AccessAssignmentRole },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(workflowId: string): Promise<
    {
        id: string;
        user_id?: string;
        shared_with_email: string;
        display_name?: string | null;
        role: AccessAssignmentRole;
        created_at?: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function getWorkflowPeople(
    workflowId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/workflows/${workflowId}/people`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}

export async function listQuickActions(
    surface: QuickAction["surface"] = "app",
    workspace?: string,
): Promise<QuickAction[]> {
    const params = new URLSearchParams({ surface });
    if (workspace) params.set("workspace", workspace);
    return apiRequest<QuickAction[]>(`/quick-actions?${params}`);
}

export async function createQuickAction(payload: {
    workflow_id: string;
    name: string;
    prompt: string;
    document_upload: boolean;
    surface: QuickAction["surface"];
    enabled?: boolean;
    sort_order?: number;
}): Promise<QuickAction> {
    return apiRequest<QuickAction>("/quick-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateQuickAction(
    quickActionId: string,
    payload: Partial<
        Pick<
            QuickAction,
            | "workflow_id"
            | "name"
            | "prompt"
            | "document_upload"
            | "surface"
            | "enabled"
            | "sort_order"
        >
    >,
): Promise<QuickAction> {
    return apiRequest<QuickAction>(`/quick-actions/${quickActionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowAddons(): Promise<WorkflowAddon[]> {
    return apiRequest<WorkflowAddon[]>("/workflow-addons");
}

export async function getWorkflowAddon(
    addonId: string,
): Promise<WorkflowAddon> {
    return apiRequest<WorkflowAddon>(`/workflow-addons/${addonId}`);
}

export async function importWorkflowAddon(addonId: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflow-addons/${addonId}/import`, {
        method: "POST",
    });
}

export async function listWorkflowAssets(
    workflowId: string,
): Promise<Document[]> {
    return apiRequest<Document[]>(`/workflows/${workflowId}/assets`);
}

export async function copyDocumentsToWorkflowAssets(
    workflowId: string,
    documentIds: string[],
): Promise<Document[]> {
    return apiRequest<Document[]>(
        `/workflows/${workflowId}/assets/from-documents`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ document_ids: documentIds }),
        },
    );
}

export async function uploadWorkflowAssets(
    workflowId: string,
    files: UploadSessionInput[],
    options?: UploadRequestOptions<Document>,
): Promise<UploadOutcome<Document>[]> {
    return uploadFilesWithSession<Document>({
        purpose: "document_create",
        destination: { scope: "workflow", workflow_id: workflowId },
        files,
        onProgress: options?.onProgress,
        signal: options?.signal,
    });
}

export function workflowAddonAssetDisplayUrl(
    addonId: string,
    assetId: string,
): string {
    return `${API_BASE}/workflow-addons/${encodeURIComponent(addonId)}/assets/${encodeURIComponent(assetId)}/display`;
}

export async function deleteWorkflowAsset(
    workflowId: string,
    assetId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/assets/${assetId}`, {
        method: "DELETE",
    });
}

export async function getGoogleWorkspaceStatus(
    provider: import("@mike/contracts").GoogleWorkspaceProvider,
) {
    return apiRequest<import("@mike/contracts").GoogleWorkspaceStatus>(
        `/user/integrations/${provider}`,
    );
}
export async function startGoogleWorkspaceOAuth(
    provider: import("@mike/contracts").GoogleWorkspaceProvider,
) {
    return apiRequest<{ authorizationUrl: string }>(
        `/user/integrations/${provider}/oauth/start`,
        { method: "POST" },
    );
}
export async function cancelGoogleWorkspaceOAuth(
    provider: import("@mike/contracts").GoogleWorkspaceProvider,
    state: string,
) {
    return apiRequest<void>(`/user/integrations/${provider}/oauth/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
    });
}
export async function disconnectGoogleWorkspace(
    provider: import("@mike/contracts").GoogleWorkspaceProvider,
) {
    return apiRequest<void>(`/user/integrations/${provider}`, {
        method: "DELETE",
    });
}
export async function updateGoogleWorkspaceSettings(
    provider: import("@mike/contracts").GoogleWorkspaceProvider,
    settings: { enabled?: boolean; requireWriteApproval?: boolean; readOnly?: boolean },
) {
    return apiRequest<import("@mike/contracts").GoogleWorkspaceStatus>(
        `/user/integrations/${provider}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
        },
    );
}
export async function setGoogleWorkspaceToolEnabled(
    provider: import("@mike/contracts").GoogleWorkspaceProvider,
    toolName: string,
    enabled: boolean,
) {
    return apiRequest<import("@mike/contracts").GoogleWorkspaceStatus>(
        `/user/integrations/${provider}/tools/${encodeURIComponent(toolName)}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}
