/**
 * E2E tests for the settings search box (MIK-65).
 *
 * Test user: this worker's account (e2eAccount; e2e@mike.local on worker 0)
 *
 * Key source facts used by these selectors:
 *  - SettingsShell.tsx: the box sits at the right end of the "Settings" title
 *    row; the section tabs and the open page keep their places.
 *  - SettingsSearch.tsx: input role "searchbox" named "Search settings";
 *    results sit in a group named "Settings search results", split into
 *    groups "Matches" and "Related"; each result button's accessible name is
 *    "<title>, <tab>. <description>" (the tab is left off when it repeats
 *    the title); Enter opens the first result; the empty state reads
 *    "No settings match …".
 *  - settingsSearch.ts: a result's href may carry a hash naming the section
 *    heading's id; the heading is scrolled into view and focused on arrival.
 */
import { test, expect, type Page } from "./fixtures";

async function openSettings(page: Page) {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible({
        timeout: 10_000,
    });
    return page.getByRole("searchbox", { name: "Search settings" });
}

const results = (page: Page) =>
    page.getByRole("group", { name: "Settings search results" });

test.describe("Settings search", () => {
    test("sits in the title row and moves nothing when it opens", async ({
        page,
    }) => {
        const search = await openSettings(page);
        const heading = page.getByRole("heading", { name: "Settings" });
        const accountTab = page
            .getByRole("navigation", { name: "Settings" })
            .getByRole("button", { name: "Account", exact: true });
        const profile = page.getByRole("heading", { name: "Profile" });
        await expect(profile).toBeVisible();

        const headingBox = (await heading.boundingBox())!;
        const searchBox = (await search.boundingBox())!;
        const tabBefore = (await accountTab.boundingBox())!;
        const profileBefore = (await profile.boundingBox())!;
        // Same row as the heading, to its right.
        // REGRESSION: fails if the box moves back above the tab column.
        expect(searchBox.x).toBeGreaterThan(headingBox.x + headingBox.width);
        expect(Math.abs(searchBox.y + searchBox.height - (headingBox.y + headingBox.height))).toBeLessThan(12);

        await search.fill("api");
        await expect(results(page)).toBeVisible();
        // The list overlays the page; the tabs and content do not shift.
        expect(await accountTab.boundingBox()).toEqual(tabBefore);
        expect(await profile.boundingBox()).toEqual(profileBefore);
        const list = (await results(page).boundingBox())!;
        // Anchored to the box's right edge, inside the page.
        expect(Math.abs(list.x + list.width - (searchBox.x + searchBox.width))).toBeLessThan(8);
    });

    test("finds a section by other words for it and opens it on click", async ({
        page,
    }) => {
        const search = await openSettings(page);
        await expect(results(page)).toHaveCount(0);

        // "api key" is nowhere in the tab's name; the index knows it as a
        // way of asking for Bring Your Own Keys.
        // REGRESSION: fails if the related-match vocabulary stops working.
        await search.fill("api key");
        const byok = results(page).getByRole("button", {
            name: /^Bring Your Own Keys\./,
        });
        await expect(byok).toBeVisible();

        await byok.click();
        await expect(page).toHaveURL(/\/settings\/byok$/, { timeout: 10_000 });
        await expect(
            page.getByRole("heading", { name: "Available Providers" }),
        ).toBeVisible({ timeout: 10_000 });
        // The box is cleared once a result is chosen.
        await expect(
            page.getByRole("searchbox", { name: "Search settings" }),
        ).toHaveValue("");
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
        ).toHaveAccessibleName(/^Memory\./);
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
            results(page).getByRole("button", { name: /^Password, Security\./ }),
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
            name: /^Delete data, Privacy & Data\./,
        });
        const second = results(page).getByRole("button", {
            name: /^Delete account, Account\./,
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
            results(page).getByRole("button", { name: /^Dark mode, Appearance\./ }),
        ).toBeVisible();

        await search.fill("qzxv");
        await expect(results(page)).toContainText("No settings match");
    });
});

test.describe("Settings search on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("shares the title row and keeps its results inside the screen", async ({
        page,
    }) => {
        const search = await openSettings(page);
        await expect(search).toBeInViewport();
        const heading = page.getByRole("heading", { name: "Settings" });
        const headingBox = (await heading.boundingBox())!;
        const searchBox = (await search.boundingBox())!;
        // Still beside the heading, not wrapped under it.
        expect(searchBox.x).toBeGreaterThan(headingBox.x + headingBox.width);

        await search.fill("2fa");
        const list = results(page);
        const mfa = list.getByRole("button", {
            name: /^Multi-Factor Authentication, Security\./,
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
