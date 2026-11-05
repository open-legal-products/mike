/**
 * taskpane.html opened outside Word: Office.js resolves onReady with no
 * host, and OfficeRuntime does not exist. Crawlers and link previews do this
 * (Sentry MIKE-WORD-ADDIN-6/7); so does a person who pastes the URL into a
 * browser. The pane must say where it belongs, never start sign-in, and
 * report nothing.
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
