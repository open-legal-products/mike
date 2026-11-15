import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeProfile } from "../user.profile.serialization";
import type { UserProfileRow } from "../user.profile.storage";
import type { RouterModelSelections } from "../../../lib/routerModels";

// The web app's MfaLoginGate only checks for an owed code when the profile
// says mfaOnLogin. When the deployment requires every enrolled factor on
// every route, the gate must run for every user, or reads fail with
// mfa_verification_required and nothing sends the user to /verify-mfa.
const routerModels = {} as RouterModelSelections;
const row = { mfa_on_login: false } as UserProfileRow;

afterEach(() => vi.unstubAllEnvs());

describe("serialized mfaOnLogin", () => {
  it("is the user's own choice by default", () => {
    expect(serializeProfile(routerModels, row).mfaOnLogin).toBe(false);
  });

  it("is on for everyone when MFA_REQUIRE_FOR_ENROLLED_USERS=true", () => {
    vi.stubEnv("MFA_REQUIRE_FOR_ENROLLED_USERS", "true");
    expect(serializeProfile(routerModels, row).mfaOnLogin).toBe(true);
  });
});
