// Facade for the contracts module (Janus contract review ported into Mike).
// Other code reaches this module only through these named exports.

export {
  buildClauseLibraryContext,
  buildPastFeedbackContext,
  buildReviewContextFor,
} from "./contracts.context";
export type { ClauseContextRow, FeedbackRow, MissedClauseRow } from "./contracts.context";

export { CONTRACT_UPLOAD_MAX_BYTES, extractContract } from "./contracts.extract";
export type { ExtractedContract } from "./contracts.extract";

export {
  callerIsAdmin,
  createReview,
  deleteReview,
  getCallerIdentity,
  getReviewDetail,
  getReviewStatus,
  isReviewOutput,
  listReviews,
  parseCreateReviewBody,
  runReview,
} from "./contracts.reviews";
export type {
  CallerIdentity,
  CreateReviewInput,
  ReviewListItem,
  ReviewListRow,
  ReviewStatus,
} from "./contracts.reviews";
export type {
  Clarification,
  FinancialItem,
  ManualCommentRow,
  MissingClause,
  NegotiationMemo,
  NegotiationPoint,
  OverallRecommendation,
  PlaybookCompliance,
  PlaybookComplianceItem,
  PositiveFinding,
  RedFlag,
  ReviewDetail,
  ReviewDetailRow,
  ReviewFeedbackRow,
  ReviewOutput,
  Revision,
  RiskLevel,
  SectionRisk,
  YellowFlag,
} from "./contracts.types";

export {
  COMMENT_TYPES,
  FEEDBACK_ACTIONS,
  LIFECYCLE_STAGES,
  MISSED_CATEGORIES,
  RECOMMENDATIONS,
  REVIEW_STATUSES,
  createComment,
  createFeedback,
  createFeedbackBulk,
  createMissedClauseSignal,
  displayNameFromEmail,
  parseClauseBody,
  parseCommentBody,
  parseFeedbackBody,
  parseFeedbackBulkBody,
  parseMissedClauseBody,
  parseReviewPatch,
  saveClauseToLibrary,
  statusForStage,
  updateReviewMeta,
} from "./contracts.feedback";
export type { ClauseInput, CommentInput, FeedbackAction, FeedbackInput, MissedClauseInput, ReviewPatch } from "./contracts.feedback";

export {
  DOCX_MIME,
  attachDocxToReview,
  getReviewFileSource,
  isStashedDocxKey,
  originalDocxKey,
  stashUploadedDocx,
} from "./contracts.files";
export type { ReviewFileSource } from "./contracts.files";

export {
  AI_AUTHOR,
  cooAuthor,
  editRevision,
  listRevisionEdits,
  projectRevisions,
  redlineDocxKey,
  resolveRevision,
  revisionToEdit,
} from "./contracts.redline";
export type { ProjectionSummary, ResolveResult, RevisionEditRow } from "./contracts.redline";

export {
  NEGOTIATION_STATUSES,
  generateNegotiationMemo,
  isNegotiationMemo,
  listNegotiationPoints,
  parsePointStatusBody,
  upsertNegotiationPoint,
} from "./contracts.memo";
export type { NegotiationPointRow, NegotiationStatus } from "./contracts.memo";
