// Service facade for the tabular-review module. Named re-exports only — the
// module's public service surface in one place, without leaking intra-module
// helpers. Routes import from the topic files directly (they live in the same
// module); everything OUTSIDE the module — the extraction worker, the
// stale-work sweep, tests that want a stable path — imports from here and
// only here.

export { loadReviewRow } from "./tabular.rows";
export { extractRowColumns, finalizeCell } from "./tabular.extractRow";
export {
    finishGenerationIfIdle,
    renewGeneration,
    validateSelectedModel,
    REVIEW_EDIT_FORBIDDEN,
    TABULAR_GENERATION_HEARTBEAT_MS,
    type Column,
} from "./tabular.shared";

export { handleExtractionExtract, markExtractionJobFailed } from "./tabular.extractionJobs";
export { sweepStaleGeneratingCells } from "./tabular.maintenance";

export { runExtractionJob, markExtractionFailed } from "./tabular.extraction";
