// Stable public API. Keep implementations in the topic files below.
export {
  type AccessibleChat,
  validateAccessibleProjectId,
  type ChatAccess,
  getAccessibleChat,
} from "./chat.access";
export { getChatMessages } from "./chat.messages";
export {
  listChats,
  createChat,
  deleteChat,
  type ChatWriteResult,
} from "./chat.crud";
export {
  listChatPeople,
  listChatGrants,
  grantChatAccess,
  revokeChatAccess,
} from "./chat.sharing";
export { updateChatSettings } from "./chat.settings";
export { updateChatTitle, generateChatTitle } from "./chat.titles";
export { type PreparedChatStream, prepareChatStream } from "./chat.prepare";
export {
  devLog,
  appendAssistantEventsToMessage,
  AssistantStreamError,
  ASSISTANT_ERROR_MESSAGE,
  buildCancelledAssistantMessage,
  extractCitations,
  isAbortError,
  runLLMStream,
  stripTransientAssistantEvents,
  PROJECT_EXTRA_TOOLS,
  parseChatMessages,
  parseOptionalAskInputsResponse,
  parseOptionalAttachedDocuments,
  parseOptionalChatId,
  parseOptionalDisplayedDoc,
  parseOptionalModel,
  parseOptionalReasoning,
  buildProjectDocContext,
  buildMessages,
  buildUserPersonalisationPrompt,
  buildWorkflowStore,
  enrichWithPriorEvents,
  appendAskInputsResponseToAssistantMessage,
  generateSpotlightNonce,
  spotlightFilename,
  type AskInputsResponseRequest,
  type AssistantEvent,
  type ChatDocumentReference,
  type ChatMessage,
  type TabularCellStore,
  TABULAR_TOOLS,
  parseOptionalDocumentContext,
  createReservedAssistantMessageUpdater,
  createWordClientToolsAdapter,
  reserveAssistantMessage,
  submitClientToolResult,
  ACTIVE_WORD_DOCUMENT_ID,
  buildDocContext,
  buildWordChatSystemPrompt,
  withoutEmptyAssistantReservations,
} from "./engine/index";
export { generateAssistantChatTitle } from "./chat.title";

export {
  persistWordDocumentEdits,
  WORD_EDIT_FORMATS,
  type WordEditApplyMode,
} from "./engine/wordDocumentEdits";
