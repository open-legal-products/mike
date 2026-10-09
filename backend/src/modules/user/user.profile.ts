// Stable public API. Keep implementations in the topic files below.
export {
  normalizeRouterModels,
} from "./user.profile.routerPreferences";
export {
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
  recordPasswordSet,
} from "./user.profile.operations";
