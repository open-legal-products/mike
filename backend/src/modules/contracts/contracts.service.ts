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
