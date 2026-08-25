// Shared plumbing for the three desktop e2e suites (app / flows / local).
//
// Both helpers here replace code that was copy-pasted into all three suites and
// had drifted away from the product:
//
//   * the packaged-app path was hardcoded to `dist/mac-arm64`, so the suites
//     could only ever find a build produced on Apple silicon — on an Intel Mac
//     they died with ENOENT before the first assertion ran;
//   * the signup steps still typed into main's OLD signup form ("Your name" /
//     "Your organisation" / "Create a password (min. 6 characters)"), which the
//     auth rework replaced with Email + Password + Confirm Password followed by
//     a two-step /onboarding wizard. Filling a placeholder that no longer
//     exists is not a soft failure in Playwright: `getByPlaceholder(...).fill()`
//     blocks until its timeout, so every suite would have died at step 2.
//
// Keeping them in one module means the next product change lands in one place
// instead of three, and the packaged-app path has a single construction point.

import path from "node:path";

// electron-builder names its macOS output directory after the arch it built
// for: arm64 → dist/mac-arm64, x64 → dist/mac. desktop/electron-builder*.json
// pin no `mac.target.arch`, so a build always follows the host — which means
// the suite can derive the directory from its own process.arch instead of
// assuming the machine that packaged the app.
export const MAC_DIST_DIR = process.arch === "arm64" ? "mac-arm64" : "mac";

export function packagedAppBinary(desktopDir) {
  return path.join(
    desktopDir,
    "dist",
    MAC_DIST_DIR,
    "Mike.app",
    "Contents",
    "MacOS",
    "Mike",
  );
}

// frontend/src/app/components/auth/passwordPolicy.ts. Signup rejects anything
// shorter client-side, so a suite carrying a too-short password would sit on
// the form staring at an error banner instead of failing usefully.
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Sign up through the real product UI, starting from /login.
 *
 * Mirrors frontend/src/app/signup/page.tsx: three labelled fields (Email,
 * Password, Confirm Password — none of them carry a placeholder to select on
 * any more, so these go by label) and a "Sign up" submit button. Selecting the
 * submit by its accessible name rather than `button[type=submit]` also keeps us
 * off the Google button, which shares the same form.
 *
 * On a local/autoconfirming stack signUp returns a session, the page shows its
 * "Account created!" card for two seconds and then pushes to
 * /onboarding/profile. Without autoconfirm it lands on /signup/check-email
 * instead — which is why the caller must follow this with
 * completeOnboardingIfRequired(), whose URL wait names the expected
 * destinations explicitly rather than accepting "anything but /login".
 */
export async function signUpThroughUi(page, { email, password }) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `e2e password is ${password.length} chars; signup requires ${MIN_PASSWORD_LENGTH}`,
    );
  }
  await page.getByRole("link", { name: "Sign up" }).click();
  await page.waitForURL(/\/signup/, { timeout: 15_000 });
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
}

/**
 * Walk a freshly authenticated account through the onboarding wizard, and do
 * nothing for an account that has already finished it.
 *
 * Port of the web suite's e2e/onboarding.ts to plain ESM (these desktop suites
 * drive playwright-core directly and can't import the @playwright/test helper).
 * The shape is deliberate: OnboardingGate
 * (frontend/src/app/components/auth/OnboardingGate.tsx) pins anyone whose
 * profile.onboardingComplete is false to /onboarding/**, and bounces everyone
 * else off it to /assistant. Both /login and /signup push to
 * /onboarding/profile unconditionally, so a RETURNING account also visits that
 * URL for a moment before the gate replaces it — meaning the URL alone cannot
 * tell the two cases apart. Waiting for "either the step-1 Continue button or
 * the assistant composer" is what disambiguates them.
 *
 * Step 1 (/onboarding/profile) collects Name + Organisation — the two fields
 * the old signup form used to ask for, which is why they are filled here — and
 * step 2 (/onboarding/practice) collects optional practice details behind a
 * "Skip" that completes onboarding and replaces the URL with /assistant.
 */
export async function completeOnboardingIfRequired(
  page,
  { name, organisation } = {},
) {
  await page.waitForURL(/\/(assistant|onboarding\/profile)/, {
    timeout: 45_000,
  });

  if (new URL(page.url()).pathname === "/onboarding/profile") {
    const continueButton = page.getByRole("button", {
      name: "Continue",
      exact: true,
    });
    const assistantInput = page.getByRole("combobox", {
      name: "How can I help?",
    });
    await continueButton
      .or(assistantInput)
      .first()
      .waitFor({ state: "visible", timeout: 20_000 });

    if (await continueButton.isVisible()) {
      if (name) await page.getByLabel("Name", { exact: true }).fill(name);
      if (organisation) {
        await page
          .getByLabel("Organisation", { exact: true })
          .fill(organisation);
      }
      await continueButton.click();
      await page.waitForURL(/\/onboarding\/practice/, { timeout: 20_000 });
      await page.getByRole("button", { name: "Skip", exact: true }).click();
    }
  }

  await page.waitForURL(/\/assistant/, { timeout: 30_000 });
}

/**
 * Dismiss whatever first-run overlay the product happens to show (welcome /
 * API-key modal): try the overlay's own dismiss affordances, then Escape, then
 * give up. Best-effort by design — there may be no overlay at all.
 */
export async function dismissFirstRunOverlay(page) {
  for (let i = 0; i < 5; i++) {
    const overlay = page.locator("div.fixed.inset-0").last();
    if (!(await overlay.isVisible().catch(() => false))) break;
    let clicked = false;
    for (const name of [/skip/i, /later/i, /got it/i, /continue/i, /close/i]) {
      const btn = overlay.getByRole("button", { name }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
}
