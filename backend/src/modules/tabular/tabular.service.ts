// Service facade for the tabular-review module. Named re-exports only — the
// module's public service surface in one place, without leaking intra-module
// helpers. Routes import from the topic files directly (they live in the same
// module); everything OUTSIDE the module — the extraction worker, the
// stale-work sweep, tests that want a stable path — imports from here and
// only here.

export {
    createRowsForReview,
    createTabularReview,
    deleteTabularReview,
    getTabularReviewDetail,
    getTabularReviewPeople,
    listTabularReviewIds,
    listTabularReviews,
    normalizeGrouping,
    rebuildRowsForReview,
    syncCellsForReviewRows,
    updateTabularReview,
    type DocumentGrouping,
    type ReviewDetail,
    type ReviewIdRow,
    type ReviewPeople,
} from "./tabular.reviews";
export {
    clearTabularReviewCells,
    regenerateTabularCell,
    type RegenerateCellOutcome,
} from "./tabular.cells";
export {
    fetchSourceDocuments,
    loadReviewRow,
    loadReviewRows,
    loadRowDocumentText,
    type ReviewRow,
    type SourceDocument,
} from "./tabular.rows";
export {
    extractDocumentMarkdown,
    extractDocxMarkdown,
    extractPdfMarkdown,
    generateChatTitle,
    queryTabularAllColumns,
    queryTabularCell,
} from "./tabular.extract";
export {
    extractRowColumns,
    finalizeCell,
    type CellSink,
} from "./tabular.extractRow";
export {
    claimTabularGeneration,
    loadTabularGenerateWork,
    preparedGenerateFailure,
    prepareTabularGenerate,
    prepareTabularRunView,
    type PreparedGenerate,
    type TabularGenerateWork,
} from "./tabular.generate";
export {
    awaitCellTerminal,
    claimCellsForGeneration,
    streamTabularGenerateAsync,
    streamTabularGenerateSync,
    streamTabularRunView,
    targetPendingCells,
} from "./tabular.generateStream";
export {
    buildTabularMessages,
    deleteTabularReviewChat,
    extractTabularAnnotations,
    listTabularReviewChatMessages,
    listTabularReviewChats,
    parseTabularCitations,
    prepareTabularChat,
    saveTabularChatTurn,
    titleTabularChat,
    updateTabularReviewChat,
    type PreparedTabularChat,
    type ReviewChatSummary,
    type TabularParsedCitation,
} from "./tabular.chats";
export {
    finishGeneration,
    finishGenerationIfIdle,
    isReviewGenerationRunning,
    parseCellContent,
    renewGeneration,
    startGenerationHeartbeat,
    statusFailure,
    validateSelectedModel,
    TABULAR_GENERATION_HEARTBEAT_MS,
    type CellResult,
    type Column,
    type TabularFailure,
    type TabularResult,
} from "./tabular.shared";
export {
    draftColumnPrompt,
    formatPromptSuffix,
    type DraftedColumnPrompt,
} from "./tabular.prompt";
