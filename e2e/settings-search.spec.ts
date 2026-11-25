/**
 * E2E tests for the settings search box (MIK-65).
 *
 * Test user: this worker's account (e2eAccount; e2e@mike.local on worker 0)
 *
 * Key source facts used by these selectors:
 *  - SettingsShell.tsx: the search is a page-header search button at the
 *    right end of the header (in the mobile header on a phone); the open
 *    page keeps its place.
 *  - SettingsSearch.tsx: a button named "Search settings" opens into an
 *    input of role "searchbox" with the same name;
 *    results sit in a group named "Settings search results", split into
 *    groups "Matches" and "Related", opening from three characters; each
 *    result shows "<tab> › <title>" and is named "<title>, <tab>" (the tab is
 *    left off when it repeats the title); Enter opens the first result; the
 *    empty state reads "No settings match …".
 *  - settingsSearch.ts: a result's href may carry a hash naming the section
 *    heading's id; the heading is scrolled into view and focused on arrival.
 */
import { test, expect, type Page } from "./fixtures";

// Opened on Account, so the search sits above a section's content.
async function openSettings(page: Page) {
    await page.goto("/settings/account");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeAttached({
        timeout: 10_000,
    });
    await page.getByRole("button", { name: "Search settings" }).click();
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await expect(search).toBeFocused();
    return search;
}

const results = (page: Page) =>
    page.getByRole("group", { name: "Settings search results" });

test.describe("Settings search", () => {
    test("sits in the page header and moves nothing when it opens", async ({
        page,
    }) => {
        const search = await openSettings(page);
        const profile = page.getByRole("heading", { name: "Profile" });
        await expect(profile).toBeVisible();

        const searchBox = (await search.boundingBox())!;
        const profileBefore = (await profile.boundingBox())!;
        // In the header above the open section.
        // REGRESSION: fails if the box drops into the page.
        expect(searchBox.y + searchBox.height).toBeLessThan(profileBefore.y);

        await search.fill("api");
        await expect(results(page)).toBeVisible();
        // The list overlays the page; the content does not shift.
        expect(await profile.boundingBox()).toEqual(profileBefore);
        const list = (await results(page).boundingBox())!;
        // Exactly as wide as the box, under it.
        expect(Math.abs(list.x - searchBox.x)).toBeLessThan(2);
        expect(Math.abs(list.width - searchBox.width)).toBeLessThan(2);
    });

    test("finds a section by other words for it and opens it on click", async ({
        page,
    }) => {
        const search = await openSettings(page);
        await expect(results(page)).toHaveCount(0);

        // "byok" is nowhere in the tab's name; the index knows it as a way of
        // asking for API Keys.
        // REGRESSION: fails if the related-match vocabulary stops working.
        await search.fill("byok");
        const byok = results(page).getByRole("button", {
            name: /^API Keys$/,
        });
        await expect(byok).toBeVisible();

        await byok.click();
        await expect(page).toHaveURL(/\/settings\/byok$/, { timeout: 10_000 });
        await expect(
            page.getByRole("heading", { name: "Available Providers" }),
        ).toBeVisible({ timeout: 10_000 });
        // Once a result is chosen the box is cleared and folds back into its
        // button.
        await expect(
            page.getByRole("button", { name: "Search settings" }),
        ).toBeVisible();
    });

    test("lists exact matches before related ones", async ({ page }) => {
        const search = await openSettings(page);
        await search.fill("memory");

        const matches = results(page).getByRole("group", { name: "Matches" });
        const related = results(page).getByRole("group", { name: "Related" });
        await expect(matches).toBeVisible();
        await expect(related).toBeVisible();
        // REGRESSION: fails if a keyword hit on another entry outranks the
        // section actually called Memory.
        await expect(
            matches.getByRole("button").first(),
        ).toHaveAccessibleName("Memory");
        // A title that merely starts with the word is still a name hit; a
        // section that only mentions it in its description is related.
        await expect(
            matches.getByRole("button", { name: /^Memory curation model,/ }),
        ).toBeVisible();
        await expect(
            related.getByRole("button", { name: /^Export data,/ }),
        ).toBeVisible();
        const matchesBox = await matches.boundingBox();
        const relatedBox = await related.boundingBox();
        expect(matchesBox && relatedBox && matchesBox.y < relatedBox.y).toBe(
            true,
        );
    });

    test("Enter opens the first result and lands on its section heading", async ({
        page,
    }) => {
        const search = await openSettings(page);
        await search.fill("password");
        await expect(
            results(page).getByRole("button", { name: /^Password, Security$/ }),
        ).toBeVisible();
        await search.press("Enter");

        await expect(page).toHaveURL(/\/settings\/security#password$/, {
            timeout: 10_000,
        });
        // The page draws its sections after loading; the search keeps looking
        // for the heading and then scrolls to it and focuses it.
        // REGRESSION: fails if a section id is renamed without the index, or
        // if the deferred scroll-and-focus stops working.
        const heading = page.getByRole("heading", { name: "Password" });
        await expect(heading).toBeFocused({ timeout: 10_000 });
        await expect(heading).toBeInViewport();
    });

    test("arrow keys move through results and Escape returns to the box", async ({
        page,
    }) => {
        const search = await openSettings(page);
        await search.fill("delete");
        const first = results(page).getByRole("button", {
            name: /^Delete data, Privacy & Data$/,
        });
        const second = results(page).getByRole("button", {
            name: /^Delete account, Account$/,
        });
        await expect(first).toBeVisible();
        await expect(second).toBeVisible();

        await search.press("ArrowDown");
        await expect(first).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(second).toBeFocused();
        await page.keyboard.press("ArrowUp");
        await expect(first).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(search).toBeFocused();
        // Escape in the box clears it and the results go away.
        await search.press("Escape");
        await expect(search).toHaveValue("");
        await expect(results(page)).toHaveCount(0);
    });

    test("typos still find the section, and nonsense says so", async ({
        page,
    }) => {
        const search = await openSettings(page);
        await search.fill("apearance");
        await expect(
            results(page).getByRole("button", { name: /^Dark mode, Appearance$/ }),
        ).toBeVisible();

        await search.fill("qzxv");
        await expect(results(page)).toContainText("No settings match");
    });
});

test.describe("Settings search on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("opens in the mobile header and keeps its results inside the screen", async ({
        page,
    }) => {
        const search = await openSettings(page);
        await expect(search).toBeInViewport();

        await search.fill("2fa");
        const list = results(page);
        const mfa = list.getByRole("button", {
            name: /^Multi-Factor Authentication, Security$/,
        });
        await expect(mfa).toBeVisible();
        const box = (await list.boundingBox())!;
        // REGRESSION: fails if the result list overflows a phone-width screen.
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);

        await mfa.click();
        await expect(page).toHaveURL(
            /\/settings\/security#multi-factor-authentication$/,
            { timeout: 10_000 },
        );
        await expect(
            page.getByRole("heading", { name: "Multi-Factor Authentication" }),
        ).toBeFocused({ timeout: 10_000 });
    });
});
