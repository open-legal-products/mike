/**
 * Auth flow E2E coverage for the Mike Word add-in.
 *
 * Exercises the real, user-visible behaviour of the login gate:
 *   - App.tsx loading spinner -> cookie-session gate -> LoginPage / floating shell / Sign out
 *   - auth/LoginPage.tsx submit-disabled gate + error alert
 *   - auth/useAuth.ts session synchronization without exposing bearer tokens
 *
 * The Mike backend auth endpoints are mocked via addin.mockLogin and the shared
 * fixture. Google dialog messages are supplied by the Office shim, so no live
 * identity provider or backend is contacted.
 */
import { test, expect } from "./support/fixtures";

test.describe("auth flow", () => {
  test("resolves the loading spinner into the login page when no token is stored", async ({
    addin,
    page,
  }) => {
    await addin.gotoTaskpane();

    // App.tsx shows <Spinner label="Loading…" /> only while the token is being
    // read from storage; once useAuth resolves with no token it must give way
    // to the LoginPage rather than getting stuck on the spinner.
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Log In" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with Google" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
    await expect(page.getByText("Mike", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign up" })).toHaveCount(0);
    await expect(page.getByText("Loading…")).toBeHidden();

    // No app shell and no legacy token storage.
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(
      0,
    );
    expect(await addin.getToken()).toBeNull();
  });

  test("Log in relies on required fields before submitting", async ({
    addin,
    page,
  }) => {
    await addin.gotoTaskpane();

    const signIn = page.getByRole("button", { name: "Log in" });
    const email = page.getByRole("textbox", { name: "Email" });
    const password = page.getByRole("textbox", { name: "Password" });

    await expect(signIn).toBeEnabled();
    await signIn.click();
    await expect(email).toBeFocused();

    await email.fill("lawyer@firm.com");
    await signIn.click();
    await expect(password).toBeFocused();

    await password.fill("hunter2");
    await expect(signIn).toBeEnabled();
  });

  test("login form fits a narrow Word task pane without horizontal overflow", async ({
    addin,
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 620 });
    await addin.gotoTaskpane();

    await expect(page.getByRole("heading", { name: "Log In" })).toBeVisible();
    const email = page.getByRole("textbox", { name: "Email" });
    const password = page.getByRole("textbox", { name: "Password" });
    await expect(email).toBeVisible();
    await expect(password).toBeVisible();
    await expect(email).toHaveClass(/bg-gray-100/);
    await expect(email).toHaveClass(/border-transparent/);
    await expect(email).toHaveClass(/shadow-none/);
    await expect(email).not.toHaveAttribute("placeholder");
    await expect(password).toHaveClass(/bg-gray-100/);
    await expect(password).toHaveClass(/border-transparent/);
    await expect(password).toHaveClass(/shadow-none/);
    await expect(password).not.toHaveAttribute("placeholder");
    const loginButton = page.getByRole("button", { name: "Log in" });
    await expect(loginButton).toHaveClass(/rounded-full/);
    await expect(loginButton).toHaveClass(/bg-gray-950\/88/);
    await expect(loginButton).not.toHaveClass(/backdrop-blur-xl/);

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(horizontalOverflow).toBeLessThanOrEqual(0);

    const panel = await page.getByTestId("login-panel").boundingBox();
    expect(panel).not.toBeNull();
    const form = await page.getByTestId("login-form").boundingBox();
    expect(form).not.toBeNull();
    const loginCard = page.getByTestId("login-card");
    await expect(loginCard).toHaveClass(/rounded-2xl/);
    await expect(loginCard).toHaveClass(/liquid-glass-flat/);
    await expect(loginCard).toHaveClass(/p-8/);
    await expect(loginCard).toHaveClass(/backdrop-blur-2xl/);
    const button = await loginButton.boundingBox();
    expect(button).not.toBeNull();
    expect(Math.abs((button?.width ?? 0) - (form?.width ?? 0))).toBeLessThan(2);
    expect(
      Math.abs((panel?.y ?? 0) + (panel?.height ?? 0) / 2 - 310),
    ).toBeLessThan(2);
    await expect(page.getByRole("heading", { name: "Log In" })).toHaveCSS(
      "text-align",
      "left",
    );
  });

  test("surfaces an error alert when credentials are rejected", async ({
    addin,
    page,
  }) => {
    await addin.mockLogin({ error: "Invalid login credentials" });
    await addin.gotoTaskpane();

    await page.getByRole("textbox", { name: "Email" }).fill("wrong@firm.com");
    await page.getByRole("textbox", { name: "Password" }).fill("badpassword");
    await page.getByRole("button", { name: "Log in" }).click();

    // LoginPage no longer echoes the server. The failure is recognised by its
    // `invalid_credentials` CODE and stated in Mike's own words, so neither
    // GoTrue's wording nor an "(HTTP 400)" suffix reaches the screen.
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("That email and password don't match an account.");
    await expect(alert).not.toContainText("Invalid login credentials");
    await expect(alert).not.toContainText("HTTP 400");

    // Failed login leaves the user on the login page with no token exposed.
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(
      0,
    );
    expect(await addin.getToken()).toBeNull();
  });

  test("valid credentials establish a cookie session and render the app shell", async ({
    addin,
    page,
  }) => {
    await addin.mockLogin({ ok: true, accessToken: "valid-jwt-123" });
    await addin.gotoTaskpane();

    await page.getByRole("textbox", { name: "Email" }).fill("lawyer@firm.com");
    await page
      .getByRole("textbox", { name: "Password" })
      .fill("correct-password");
    await page.getByRole("button", { name: "Log in" }).click();

    // Successful grant swaps the LoginPage for the authenticated floating shell.
    await addin.expectAuthedShell();
    await expect(page.getByRole("button", { name: "Log in" })).toHaveCount(0);

    // Auth state is represented by the server cookie; bearer tokens never enter
    // OfficeRuntime.storage where add-in JavaScript could read them.
    expect(await addin.getToken()).toBeNull();
    expect(await addin.getRefreshToken()).toBeNull();
  });

  test("Google OAuth redeems a one-time handoff into a task-pane cookie session", async ({
    addin,
    page,
  }) => {
    await addin.gotoTaskpane();

    await page.getByRole("button", { name: "Continue with Google" }).click();
    const dialog = await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __OAUTH_DIALOG__: {
            url: string;
            options: Record<string, unknown>;
          };
        }
      ).__OAUTH_DIALOG__;
      return { url: state.url, options: state.options };
    });
    const requestId = new URL(dialog.url).searchParams.get("requestId");
    expect(requestId).toBeTruthy();
    expect(dialog.options).toMatchObject({ displayInIframe: false });

    await page.evaluate(
      ({ requestId }) => {
        const state = (
          window as typeof window & {
            __OAUTH_DIALOG__: {
              sendMessage: (message: string, origin?: string) => void;
            };
          }
        ).__OAUTH_DIALOG__;
        state.sendMessage(
          JSON.stringify({
            type: "mike-google-oauth",
            requestId,
            status: "success",
            handoffTicket: "a".repeat(43),
          }),
        );
      },
      { requestId },
    );

    await addin.expectAuthedShell();
    expect(await addin.getToken()).toBeNull();
    expect(await addin.getRefreshToken()).toBeNull();
  });

  test("Google OAuth rejects a response from another origin", async ({
    addin,
    page,
  }) => {
    await addin.gotoTaskpane();
    await page.getByRole("button", { name: "Continue with Google" }).click();

    const requestId = await page.evaluate(() => {
      const state = (
        window as typeof window & { __OAUTH_DIALOG__: { url: string } }
      ).__OAUTH_DIALOG__;
      return new URL(state.url).searchParams.get("requestId");
    });

    await page.evaluate(
      ({ requestId }) => {
        const state = (
          window as typeof window & {
            __OAUTH_DIALOG__: {
              sendMessage: (message: string, origin?: string) => void;
            };
          }
        ).__OAUTH_DIALOG__;
        state.sendMessage(
          JSON.stringify({
            type: "mike-google-oauth",
            requestId,
            status: "success",
            handoffTicket: "a".repeat(43),
          }),
          "https://attacker.example",
        );
      },
      { requestId },
    );

    await expect(page.getByRole("alert")).toContainText("unexpected origin");
    expect(await addin.getToken()).toBeNull();
    expect(await addin.getRefreshToken()).toBeNull();
  });

  test("Google OAuth surfaces provider errors", async ({ addin, page }) => {
    await addin.gotoTaskpane();
    await page.getByRole("button", { name: "Continue with Google" }).click();

    await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __OAUTH_DIALOG__: {
            url: string;
            sendMessage: (message: string, origin?: string) => void;
          };
        }
      ).__OAUTH_DIALOG__;
      const requestId = new URL(state.url).searchParams.get("requestId");
      state.sendMessage(
        JSON.stringify({
          type: "mike-google-oauth",
          requestId,
          status: "error",
          message: "Google access was denied",
        }),
      );
    });

    await expect(page.getByRole("alert")).toContainText(
      "Google access was denied",
    );
    expect(await addin.getToken()).toBeNull();
  });

  test("Google OAuth rejects malformed dialog messages", async ({
    addin,
    page,
  }) => {
    await addin.gotoTaskpane();
    await page.getByRole("button", { name: "Continue with Google" }).click();

    await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __OAUTH_DIALOG__: {
            sendMessage: (message: string, origin?: string) => void;
          };
        }
      ).__OAUTH_DIALOG__;
      state.sendMessage("not-json");
    });

    await expect(page.getByRole("alert")).toContainText("invalid response");
    expect(await addin.getToken()).toBeNull();
  });

  test("Google OAuth reports when the user closes the dialog", async ({
    addin,
    page,
  }) => {
    await addin.gotoTaskpane();
    await page.getByRole("button", { name: "Continue with Google" }).click();

    await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __OAUTH_DIALOG__: { sendEvent: (error: number) => void };
        }
      ).__OAUTH_DIALOG__;
      state.sendEvent(12006);
    });

    await expect(page.getByRole("alert")).toContainText(
      "Google sign-in was cancelled",
    );
    expect(await addin.getToken()).toBeNull();
  });

  test("Sign out clears the server session and returns to the login page", async ({
    addin,
    page,
  }) => {
    addin.seedToken("seeded-jwt");
    await addin.gotoTaskpane();

    // Pre-seeded server cookie session => app shell renders straight away.
    await addin.expectAuthedShell();

    // Sign out lives in the navigation menu, not in Settings.
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    // Logout invalidates the cookie session and falls back to the LoginPage.
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveCount(
      0,
    );
    expect(await addin.getToken()).toBeNull();
  });

  test("a failed sign out keeps the active session visible and reports the error", async ({
    addin,
    page,
  }) => {
    addin.seedToken("seeded-jwt");
    await page.route("**/auth/logout", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Sign out is temporarily unavailable" }),
      }),
    );
    await addin.gotoTaskpane();
    await addin.expectAuthedShell();

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    // A 5xx body is never echoed, however friendly it looks: 503 reads as a
    // temporary outage.
    await expect(page.getByRole("alert")).toContainText(
      "Mike is temporarily unavailable",
    );
    await addin.expectAuthedShell();
  });

  test("a pre-seeded cookie session survives a task-pane reload", async ({
    addin,
    page,
  }) => {
    addin.seedToken("persisted-jwt");
    await addin.gotoTaskpane();

    // No login interaction needed — the backend session endpoint resolves the
    // current user and App.tsx renders the authenticated shell directly.
    await addin.expectAuthedShell();
    await expect(page.getByRole("button", { name: "Log in" })).toHaveCount(0);
    expect(await addin.getToken()).toBeNull();
    expect(await addin.getRefreshToken()).toBeNull();

    await addin.reloadTaskpane();
    await addin.expectAuthedShell();
  });
});

/**
 * Cookie-session security and expiry coverage for auth/session.ts.
 */
test.describe("cookie session", () => {
  test("legacy Office token storage is erased during migration", async ({
    addin,
  }) => {
    addin.seedToken("legacy-access-token");
    addin.seedRefreshToken("legacy-refresh-token");
    await addin.gotoTaskpane();
    await addin.expectAuthedShell();
    expect(await addin.getToken()).toBeNull();
    expect(await addin.getRefreshToken()).toBeNull();
  });

  test("authenticated API calls use same-origin cookies without bearer headers", async ({
    addin,
    page,
  }) => {
    addin.seedToken("cookie-session");
    let authorization: string | undefined;
    let requestOrigin = "";
    await page.route("**/workflows**", (route, request) => {
      authorization = request.headers()["authorization"];
      requestOrigin = new URL(request.url()).origin;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    });

    await addin.gotoTaskpane();
    await addin.expectAuthedShell();
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("menuitem", { name: "Workflows" }).click();
    await expect(page.getByText("No workflows found.")).toBeVisible();
    expect(authorization).toBeUndefined();
    expect(requestOrigin).toBe("http://localhost:3100");
  });

  test("an expired backend session returns the task pane to login", async ({
    addin,
    page,
  }) => {
    addin.seedToken("expired-cookie-session");
    await page.route("**/workflows**", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Invalid or expired session" }),
      }),
    );

    // Override only after the initial cookie session has mounted.
    await addin.gotoTaskpane();
    await addin.expectAuthedShell();
    await page.route("**/auth/session", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Invalid or expired session" }),
      }),
    );
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("menuitem", { name: "Workflows" }).click();
    await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
  });
});
