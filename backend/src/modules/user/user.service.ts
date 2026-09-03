// Business logic + data-access for the user module.
//
// These functions are the service layer behind user.routes.ts. They take an
// explicit Supabase client (`db`) plus request-derived primitives, perform the
// profile / MFA / API-key / MCP / export / deletion orchestration, and RETURN
// values or typed error results. They never touch req/res — the thin route
// handlers map the results onto HTTP status codes, headers, and response
// bodies.
//
// The implementation is split by concern across sibling files; this module is
// the aggregate surface the routes (and tests) import from:
//
//   user.shared.ts   — shared types + helpers (Db, errorMessage)
//   user.profile.ts  — load/serialize/validate + bootstrap/read/update profile
//   user.mfa.ts      — the MFA-on-login toggle (+ verified-TOTP factor lookup)
//   user.apiKeys.ts  — BYO API-key status + save (over user.apiKeyStore.ts)
//   user.apiKeyStore.ts — the encrypted per-user API-key store itself
//   user.settings.ts — per-user model settings + last-selected model/reasoning
//   user.mcp.ts      — MCP connector wrappers over lib/mcpConnectors
//   user.account.ts  — destructive account/data deletion (args + ordering kept)
//   user.export.ts   — data-export payload builders + the durable async
//                      export flow (enqueue / poll / download artifact)
//
// Security boundaries preserved across the split verbatim:
//   - API-key crypto: writes funnel through saveUserApiKey (never reimplemented).
//   - MFA: the requireMfaIfEnrolled guard stays in the route (HTTP layer); only
//     the verified-TOTP factor lookup lives here.
//   - Data deletion: the userDataCleanup helpers + auth-admin deleteUser call are
//     invoked with identical args and ordering (destructive — exact preservation).
//   - Exports: the payload builders are called here; the route owns the
//     Content-Type / Content-Disposition headers and filenames.
//
// The re-exports below are NAMED so intra-module helpers (e.g. the profile-row
// loaders reused by user.mfa.ts) stay off this public surface — the routes and
// tests import exactly the same names they always did.

export { errorMessage } from "./user.shared";

export {
    validateProfilePayload,
    validateOnboardingPayload,
    normalizeRouterModels,
    readBooleanBodyField,
    bootstrapUserProfile,
    getUserProfile,
    lookupUserByEmail,
    updateUserProfile,
    completeUserOnboarding,
    recordPasswordSet,
    type PersonalisationUpdate,
    type RecordPasswordSetResult,
} from "./user.profile";

export { setMfaOnLogin, type SetMfaOnLoginResult } from "./user.mfa";

export {
    getApiKeyStatus,
    saveApiKey,
    type SaveApiKeyResult,
} from "./user.apiKeys";

export {
    listMcpConnectors,
    getMcpConnector,
    createMcpConnector,
    updateMcpConnector,
    deleteMcpConnector,
    startMcpConnectorOAuth,
    refreshMcpConnectorTools,
    setMcpToolEnabled,
    type RefreshMcpToolsResult,
} from "./user.mcp";

export {
    deleteUserAccount,
    deleteUserChats,
    deleteUserProjectsData,
    deleteUserTabularReviews,
} from "./user.account";

export {
    exportUserAccount,
    exportUserChats,
    exportUserTabularReviews,
    validateExportRequest,
    startUserExport,
    getUserExportStatus,
    loadUserExportArtifact,
    type ValidateExportRequestResult,
    type StartUserExportResult,
    type UserExportStatus,
    type UserExportArtifact,
} from "./user.export";

// Per-user settings and the API-key store are user-domain data that other
// modules (chat, project-chat, word-chat, tabular, models, source-documents)
// read through this facade rather than reaching into the topic files.
export {
    getUserModelSettings,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
    type UserModelSettings,
} from "./user.settings";
export {
    getUserApiKeys,
    getUserApiKeyStatus,
    hasEnvApiKey,
    normalizeApiKeyProvider,
    saveUserApiKey,
    type ApiKeyProvider,
    type ApiKeySource,
    type ApiKeyStatus,
} from "./user.apiKeyStore";
