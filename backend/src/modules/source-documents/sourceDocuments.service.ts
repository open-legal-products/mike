// Facade of the source-documents module.
//
// Behind sourceDocuments.routes.ts and the chat engine. Provider-backed
// source documents (case law today) are hydrated by the provider that owns
// the opaque id; the registry in sourceDocuments.providers.ts is the one
// place a provider is named. Service code takes an explicit Supabase client
// (`db`) plus request-derived primitives and RETURNS typed results; it never
// touches req/res.
//
// The failure union is module-specific rather than the shared `ServiceResult`
// because an upstream provider failure answers 502, a status the shared
// vocabulary does not carry.

export type {
  SourceDocumentResult,
  SourceProvider,
  SourceProviderFetchArgs,
} from "./sourceDocuments.types";
export {
  externalSourceFromMcpCall,
  getSourceDocument,
  isExternalSourceDocumentId,
  mcpResultCharsFor,
  sourceProviderFor,
} from "./sourceDocuments.providers";
export { COURTLISTENER_CREDENTIAL_DETAIL } from "./sourceDocuments.courtlistener";
export { LEGAL_DATA_HUNTER_CONNECT_DETAIL } from "./sourceDocuments.legalDataHunter";
