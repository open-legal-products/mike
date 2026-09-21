/**
 * E2E test for the complete USPTO Patent & Trademark connector setup flow.
 *
 * Test user: e2e@mike.local / E2eTestPass1! (session loaded from e2e/.auth/user.json)
 *
 * Flow: enable the feature in Settings > Features, then run the one-click
 * setup in Settings > Connectors. The managed connector requires the pinned
 * Python runtime on the backend host (Docker image or a native uv install).
 * When the runtime is absent the backend answers 409 runtime_unavailable;
 * the test skips in that case so it can run against either kind of backend.
 *
 * Key source facts used by these selectors:
 *  - settings/features/page.tsx: ToggleSwitchUI aria-label "USPTO Patent & Trademark"
 *  - settings/connectors/page.tsx: pill button text "USPTO"
 *  - connectors page managed subtitle: "Managed stdio · patent-mcp-server 1.0.0"
 *  - managed details note: "Managed local connector. Mike runs it and controls its endpoint."
 */
import { test, expect } from "@playwright/test";

test.describe("USPTO Patent & Trademark connector", () => {
    test("complete setup flow from the feature switch to managed details", async ({
        page,
    }) => {
        // 1. Turn the feature on. The switch defaults to off.
        await page.goto("/settings/features");
        const toggle = page.getByRole("switch", {
            name: "USPTO Patent & Trademark",
        });
        await expect(toggle).toBeVisible({ timeout: 10_000 });
        if ((await toggle.getAttribute("aria-checked")) !== "true") {
            await toggle.click();
            await expect(toggle).toHaveAttribute("aria-checked", "true", {
                timeout: 10_000,
            });
        }

        // 2. The Features row links to the Connectors setup.
        const setupLink = page.getByRole("link", {
            name: "Set up in Connectors",
        });
        await expect(setupLink).toBeVisible();
        await setupLink.click();
        await expect(page).toHaveURL(/\/settings\/connectors/);

        // 3. Run the one-click setup. The first launch can install a managed
        // Python on native backends, so allow generous time.
        await page
            .getByRole("button", { name: "USPTO", exact: true })
            .click();

        const runtimeError = page.getByText(/runtime is not available/);
        const connectorCard = page.getByText("USPTO Patent & Trademark", {
            exact: false,
        });
        const outcome = await Promise.race([
            runtimeError
                .waitFor({ state: "visible", timeout: 240_000 })
                .then(() => "no-runtime" as const),
            connectorCard
                .first()
                .waitFor({ state: "visible", timeout: 240_000 })
                .then(() => "provisioned" as const),
        ]);
        test.skip(
            outcome === "no-runtime",
            "Backend has no USPTO connector runtime (Docker image or native uv install required).",
        );

        // 4. The managed connector shows its fixed subtitle, and its details
        // expose tools but no endpoint form and no Delete action.
        await expect(
            page.getByText("Managed stdio · patent-mcp-server 1.0.0").first(),
        ).toBeVisible();
        await connectorCard.first().click();
        await expect(
            page.getByText(
                "Managed local connector. Mike runs it and controls its endpoint.",
            ),
        ).toBeVisible({ timeout: 15_000 });
        await expect(
            page.getByRole("button", { name: "Delete connector" }),
        ).toHaveCount(0);
        await expect(page.getByLabel("URL endpoint")).toHaveCount(0);
    });
});
