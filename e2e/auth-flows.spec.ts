/**
 * Authentication flow E2E tests:
 *   1. Login: invalid credentials show an error message
 *   2. Login: valid credentials redirect to /assistant
 *   3. Logout redirects to /login
 *   4. All protected routes redirect unauthenticated users to /login
 *
 * Tests 1, 2, and 4 run in a fresh browser context (no stored session).
 * Test 3 inherits the authenticated storageState from the Playwright project
 * config (e2e/.auth/user.json), so auth.setup.ts must run first.
 */
import { test, expect } from "@playwright/test";
import { completeOnboardingIfRequired } from "./onboarding";

/* ─── Unauthenticated tests ───────────────────────────────────────────────── */

/* describe-scoped test.use so only these tests run without a stored session.
   File-level test.use would wipe the storageState for the authenticated
   logout test below. */
test.describe("unauthenticated", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    /* ── Test 1: invalid credentials show error ──────────────────────────── */

    test("login with invalid credentials shows error message", async ({
        page,
    }) => {
        await page.goto("/login");
        await expect(page).toHaveURL(/\/login/);

        await page.fill("#email", "e2e@mike.local");
        await page.fill("#password", "definitely-wrong-password");
        await page.click('button[type="submit"]');

        /* No "networkidle" wait here: the expect() below already retries until
           React has set the `error` state and re-rendered, and it names the
           element we actually care about, so a hang fails pointing at the
           missing banner instead of at an inscrutable load state. */

        /* The login page conditionally renders:
               <div className="text-red-600 text-sm bg-red-50 p-3 rounded">
                   {error}
               </div>
           when the `error` state is non-null after a failed signInWithPassword.
           REGRESSION: fails if the error <div className="bg-red-50"> is removed
           from the login form or if the catch block stops setting `error`. */
        await expect(page.locator("div.bg-red-50.text-red-600")).toBeVisible({
            timeout: 10_000,
        });
    });

    /* ── Test 2: valid credentials redirect to /assistant ─────────────────── */

    test("login with valid credentials redirects to /assistant", async ({
        page,
    }) => {
        /* Use the SAME credentials auth.setup.ts bootstrapped the shared user
           with. Both read process.env.E2E_EMAIL / E2E_PASSWORD (falling back to
           the local defaults). CI overrides E2E_PASSWORD to a value DIFFERENT
           from the old hardcoded "E2eTestPass1!", so hardcoding it here typed a
           password the user was never created with → signInWithPassword failed,
           the error banner rendered, and the /assistant redirect never fired.
           Reading the env keeps the typed password in lock-step with the
           bootstrapped one in every environment. */
        const email = process.env.E2E_EMAIL ?? "e2e@mike.local";
        const password = process.env.E2E_PASSWORD ?? "E2eTestPass1!";

        await page.goto("/login");
        await expect(page).toHaveURL(/\/login/);

        await page.fill("#email", email);
        await page.fill("#password", password);
        await page.click('button[type="submit"]');

        /* REGRESSION: fails if `router.push("/assistant")` is removed from
           the handleLogin success branch in frontend/src/app/login/page.tsx. */
        await expect(page).toHaveURL(/\/assistant/, { timeout: 15_000 });
    });

    /* ── Test 4: all protected routes redirect to /login ─────────────────── */

    test("all protected routes redirect unauthenticated users to /login", async ({
        page,
    }) => {
        /* Every route under the (pages) route group is protected by the layout
           auth guard:
               if (!authLoading && !isAuthenticated) { router.push("/login"); }
           in frontend/src/app/(pages)/layout.tsx.
           REGRESSION: fails if that router.push("/login") is removed from the
           layout, or if any of these routes is moved outside the (pages) group
           without adding its own auth guard. */
        const protectedRoutes = [
            "/projects",
            "/tabular-reviews",
            "/workflows",
            "/settings",
        ];

        for (const route of protectedRoutes) {
            await page.goto(route);
            /* Auth check is client-side (Supabase getSession) — allow time for
               the async check to resolve and for Next.js router.push to fire. */
            await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
        }
    });
});

/* ─── Authenticated tests ─────────────────────────────────────────────────── */

/* ── Test 3: logout redirects to /login ─────────────────────────────────── */

/* The logout flow calls supabase.auth.signOut(), which defaults to GLOBAL
   scope and revokes the user's session server-side. If this ran against the
   shared `e2e@mike.local` user it would 401 every other parallel worker
   ("Invalid or expired token"). So this test starts from a clean session and
   logs in as a DEDICATED user (created in auth.setup.ts) whose session can be
   safely destroyed without affecting any other test. */
test.describe("logout (isolated user)", () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    const logoutEmail =
        process.env.E2E_LOGOUT_EMAIL ?? "e2e-logout@mike.local";
    const logoutPassword =
        process.env.E2E_LOGOUT_PASSWORD ?? "E2eLogoutPass1!";

    test("logout from settings redirects to /login", async ({
        page,
    }) => {
        /* Log in fresh as the dedicated logout user. */
        await page.goto("/login");
        await expect(page).toHaveURL(/\/login/);
        await page.fill("#email", logoutEmail);
        await page.fill("#password", logoutPassword);
        await page.click('button[type="submit"]');

        await completeOnboardingIfRequired(page);
        await page.waitForURL(/\/assistant/, { timeout: 15_000 });
        /* The sidebar's own expect() below is the real settle-wait — it
           retries on the element this test goes on to click. networkidle
           never fires against an app with SSE and polling in flight. */

    /* The AppSidebar renders a user-profile toggle button at the very bottom
       of the sidebar. The button wraps a circular div that shows the user's
       initial:
           <div className="h-7 w-7 ... rounded-full bg-gray-700 ...">
               {getUserInitials(user.email)}
           </div>
       Locate the button by the presence of that inner div. */
    const userMenuButton = page.locator("button").filter({
        has: page.locator("div.rounded-full.bg-gray-700"),
    });
    await expect(userMenuButton).toBeVisible({ timeout: 10_000 });
    await userMenuButton.click();

    /* The dropdown that appears contains a "Settings" button which
       navigates to /settings via router.push("/settings"). */
    const accountSettingsItem = page.getByRole("button", {
        name: "Settings",
    });
    await expect(accountSettingsItem).toBeVisible({ timeout: 5_000 });
    await accountSettingsItem.click();

    await expect(page).toHaveURL(/\/settings/, { timeout: 10_000 });

    /* Sign out now lives in the account dropdown rather than the Settings
       page. Reopen the same sidebar menu after navigation and exercise the
       relocated action — waiting for the sidebar button to re-render after the
       route change, which is what the "networkidle" wait here was standing in
       for (badly: it can't tell a settled page from a stalled one). */
    await expect(userMenuButton).toBeVisible({ timeout: 10_000 });
    await userMenuButton.click();
    const signOutButton = page.getByRole("button", {
        name: "Sign out",
        exact: true,
    });
    await expect(signOutButton).toBeVisible({ timeout: 5_000 });
    await signOutButton.click();

    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    });
});
