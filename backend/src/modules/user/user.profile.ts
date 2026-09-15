// Stable public API. Keep implementations in the topic files below.
export {
  ROUTER_PROFILE_FIELDS,
  normalizeRouterModels,
} from "./user.profile.routerPreferences";
export {
  type PersonalisationUpdate,
  validateProfilePayload,
  validateOnboardingPayload,
  readBooleanBodyField,
} from "./user.profile.validation";
export { ensureProfileRow, loadProfile } from "./user.profile.load";
export {
  bootstrapUserProfile,
  getUserProfile,
  lookupUserByEmail,
  updateUserProfile,
  completeUserOnboarding,
  type RecordPasswordSetResult,
  recordPasswordSet,
} from "./user.profile.operations";
