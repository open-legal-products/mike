import { test as setup } from "@playwright/test";
import { ensureUser } from "./users";

/**
 * Bootstrap the dedicated user for destructive auth tests such as logout,
 * whose GLOBAL sign-out would revoke any session it shared. The per-worker
 * accounts every other authenticated test uses are created and signed in on
 * demand by the `workerStorageState` fixture in fixtures.ts.
 */
setup("authenticate", async () => {
    await ensureUser(
        process.env.E2E_LOGOUT_EMAIL ?? "e2e-logout@mike.local",
        process.env.E2E_LOGOUT_PASSWORD ?? "E2eLogoutPass1!",
    );
});
