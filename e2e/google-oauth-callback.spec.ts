import { test, expect } from "@playwright/test";

// Real Next gateway, Express auth and local database, with deliberately invalid
// state/code. No Google consent, token exchange or account access is performed.
for (const provider of ["google-drive", "gmail", "google-calendar"]) {
  test(`${provider} callback relays to the web session and rejects invalid state`, async ({
    page,
    playwright,
    baseURL,
  }) => {
    const callback = `/api/user/integrations/${provider}/oauth/callback?state=invalid-state&code=invalid-code`;
    const response = await page.goto(callback);
    // Authenticated browser reaches state validation, not an auth failure.
    expect(response?.status()).toBe(400);
    await expect(page).toHaveURL(
      new RegExp(`/api/user/integrations/${provider}/oauth/finish\\?`),
    );
    await expect(
      page.getByRole("heading", { name: "Authorization failed" }),
    ).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(
      "invalid-code",
    );
    const anonymous = await playwright.request.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const denied = await anonymous.get(callback);
      expect(denied.status()).toBe(401);
      expect(denied.headers()["cache-control"]).toBe("no-store");
      expect(denied.headers()["referrer-policy"]).toBe("no-referrer");
    } finally {
      await anonymous.dispose();
    }
  });
}
