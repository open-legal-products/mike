// Composition root: domain handlers are reached through their public facades.
import { handleChatTurnAudit } from "../modules/audit/audit.service";
import { handleAccountDelete, handleExportBuild, handleMcpRefreshToken } from "../modules/user/user.service";
import { handleDocumentCleanup, handleDocumentPrecomputeText, handleConversionConvert, markConversionFailed } from "../modules/documents/documents.service";
import { handleExtractionExtract, markExtractionJobFailed } from "../modules/tabular/tabular.service";
import { handleMemoryConsolidation, markMemoryConsolidationFailed } from "../modules/memory/memory.service";
import { handleStorageCleanup } from "../lib/dbq/storageCleanup";
import { type DbJobHandlers } from "../lib/dbq/types";
import { type DbJobFailureHook } from "../lib/dbq/runner";

export const DB_JOB_HANDLERS: DbJobHandlers = {
  "audit.chat_turn": handleChatTurnAudit,
  "account.delete": handleAccountDelete,
  "storage.cleanup": handleStorageCleanup,
  "document.cleanup": handleDocumentCleanup,
  "export.build": handleExportBuild,
  "conversion.convert": handleConversionConvert,
  "extraction.extract": handleExtractionExtract,
  "mcp.refresh_token": handleMcpRefreshToken,
  "document.precompute_text": handleDocumentPrecomputeText,
  "memory.consolidate": handleMemoryConsolidation,
};
export const DB_JOB_FAILURE_HOOKS: Record<string, DbJobFailureHook> = {
  "conversion.convert": markConversionFailed,
  "extraction.extract": markExtractionJobFailed,
  "memory.consolidate": markMemoryConsolidationFailed,
};
export {
  handleChatTurnAudit,
  handleAccountDelete,
  handleExportBuild,
  handleMcpRefreshToken,
  handleDocumentPrecomputeText,
  handleConversionConvert,
  handleExtractionExtract,
  handleStorageCleanup,
};
export { EXPORT_TYPES, MAX_ZIP_EXPORT_DOCUMENTS, MCP_TOKEN_REFRESH_WINDOW_MS, type ExportType } from "../modules/user/user.service";
