/**
 * taskpane.html opened outside Word: Office.js resolves onReady with no
 * host, and OfficeRuntime does not exist. Crawlers and link previews do this
 * (Sentry MIKE-WORD-ADDIN-6/7); so does a person who pastes the URL into a
 * browser. The pane must say where it belongs, never start sign-in, and
 * report nothing. The one exception is an Office client that reports its
 * diagnostics but no host: that is a misdetected real Word, and it sends a
 * single warning so the lockout is not invisible.
 */
import { test, expect } from "./support/fixtures";
import { installOfficeMock } from "./support/office-mock";

test("outside Office the pane points to Word without signing in or reporting", async ({
  addin: _addin,
  page,
}) => {
  const sessionRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/auth/session")) sessionRequests.push(request.url());
  });
  const envelopes: string[] = [];
  await page.route("**/api/1/envelope/**", (route, request) => {
    envelopes.push(request.postData() ?? "");
    return route.fulfill({ status: 200, body: "{}" });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.addInitScript(installOfficeMock, { outsideOffice: true });
  await page.goto("/taskpane.html");

  await expect(page.getByText("Open Mike in Word")).toBeVisible();
  await expect(page.getByRole("button", { name: "Log in" })).toHaveCount(0);
  // Let any deferred effect or report flush before asserting absence.
  await page.waitForTimeout(500);
  expect(sessionRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(envelopes).toEqual([]);
});

test("a hostless onReady inside an Office client sends one warning", async ({
  addin: _addin,
  page,
}) => {
  const envelopes: string[] = [];
  await page.route("**/api/1/envelope/**", (route, request) => {
    envelopes.push(request.postData() ?? "");
    return route.fulfill({ status: 200, body: "{}" });
  });

  await page.addInitScript(installOfficeMock, {
    outsideOffice: true,
    outsideOfficeDiagnostics: true,
  });
  await page.goto("/taskpane.html");

  await expect(page.getByText("Open Mike in Word")).toBeVisible();
  await expect.poll(() => envelopes.length).toBe(1);
  await page.waitForTimeout(500);
  expect(envelopes).toHaveLength(1);
  // Message text is dropped at the privacy boundary; the tags name it.
  expect(envelopes[0]).toContain('"error_kind":"office_host_null"');
  expect(envelopes[0]).toContain('"operation":"office.on_ready"');
  expect(envelopes[0]).toContain('"level":"warning"');
});
