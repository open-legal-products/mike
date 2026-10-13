import { test, expect } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

// Browser-boundary regressions only: the API and OAuth provider below are
// fixtures. These do not establish live LDH authorization or retrieval.
test("LDH Discover preset uses the shared OAuth popup and Installed controls", async ({ page, context }, testInfo) => {
    let connected = false;
    let created = false;
    const connector = () => ({
        id: "ldh-browser", name: "Legal Data Hunter",
        serverUrl: "https://legaldatahunter.com/mcp", transport: "streamable_http",
        authType: "oauth", enabled: true, readOnly: false, requireWriteApproval: false,
        hasAuthConfig: connected, customHeaderKeys: [], oauthConnected: connected,
        toolPolicy: {}, toolCount: connected ? 1 : 0,
        createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z",
        tools: connected ? [{
            id: "ldh-get", toolName: "get_document", openaiToolName: "mcp_ldh_get_document",
            title: "Get document", description: "Retrieve a legal document.",
            enabled: true, readOnly: true, destructive: false,
            lastSeenAt: "2026-10-13T00:00:00Z",
        }] : [],
    });
    await context.route("**/ldh-oauth-fixture", route => route.fulfill({
        contentType: "text/html",
        body: '<button type="button" onclick="window.opener.postMessage({type:\'mcp_oauth_result\',success:true,connectorId:\'ldh-browser\'},location.origin)">Authorize test connection</button>',
    }));
    await page.route("**/api/**", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/auth/session") return route.fulfill({ json: { user: { id: "ldh-ui-user", email: "synthetic@example.com" } } });
        if (url.pathname === "/api/user/profile") return route.fulfill({ json: { onboardingComplete: true, displayName: "Synthetic", apiKeyStatus: {} } });
        if (url.pathname === "/api/user/mcp-connectors") {
            if (request.method() === "POST") {
                expect(request.postDataJSON()).toMatchObject({ name: "Legal Data Hunter", serverUrl: "https://legaldatahunter.com/mcp" });
                created = true;
                return route.fulfill({ json: { connector: connector(), oauthRequired: true } });
            }
            return route.fulfill({ json: created ? [connector()] : [] });
        }
        if (url.pathname.endsWith("/oauth/start")) return route.fulfill({ json: {
            authorizationUrl: `${url.origin}/ldh-oauth-fixture`, callbackOrigin: url.origin,
        } });
        if (url.pathname.endsWith("/refresh-tools")) connected = true;
        if (url.pathname.startsWith("/api/user/mcp-connectors/")) return route.fulfill({ json: connector() });
        return route.fulfill({ json: [] });
    });
    await page.goto("/settings/connectors");
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Add Legal Data Hunter connector", exact: true }).click();
    const popup = await popupPromise;
    await popup.getByRole("button", { name: "Authorize test connection" }).click();
    await page.getByRole("button", { name: "Manage Legal Data Hunter", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Legal Data Hunter", exact: true });
    await expect(dialog.getByRole("switch", { name: "Read-only", exact: true })).toBeVisible();
    await expect(dialog.getByRole("switch", { name: "Get document enabled" })).toBeChecked();
    expect(connected).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("ldh-connected.png"), animations: "disabled" });
});

for (const type of ["case", "legislation", "legal_research"] as const) {
    test(`LDH ${type} citation opens its inline source without uploaded-document requests`, async ({ page }, testInfo) => {
        const title = `Synthetic LDH ${type} source`;
        const quote = "This is a fixture provision, not an actual legal authority.";
        const documentId = "mcp:ldh-browser:7:fixture:1:1";
        const uploadedDocumentRequests: string[] = [];
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        const chat = { id: "ldh-citation", title: "LDH citation fixture", user_id: "ldh-ui-user", project_id: null, model: "test-model", created_at: "2026-10-13T00:00:00Z", is_owner: true, access_role: "owner" };
        const citation = {
            type: "citation_data", kind: "document", ref: 1,
            doc_id: "doc-0", document_id: documentId, filename: title,
            page: 1, quote, quotes: [{ page: 1, quote, verification: { verified: true } }],
            document: {
                document_id: documentId, title, type, metadata: [],
                actions: [{ type: "link", label: "Official source", url: "https://example.com/public-source" }],
                quotes: [{ quote, verification: { verified: true }, target: { subdocument_id: `${documentId}:text` } }],
                subdocuments: [{ document_id: `${documentId}:text`, title, type: "html", text: `${quote}\n\n<script>window.ldhInjected = true</script>` }],
            },
        };
        await page.route("**/api/**", async route => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/api/auth/session") return route.fulfill({ json: { user: { id: "ldh-ui-user", email: "synthetic@example.com" } } });
            if (path === "/api/user/profile") return route.fulfill({ json: { onboardingComplete: true, displayName: "Synthetic", apiKeyStatus: {}, creditsRemaining: 100 } });
            if (path === "/api/models/configured") return route.fulfill({ json: { models: [{ id: "test-model", label: "Test model", source: "Configured" }] } });
            if (path === "/api/chat/ldh-citation") return route.fulfill({ json: {
                chat, is_owner: true, access_role: "owner", messages: [
                    { id: "ldh-question", role: "user", content: "Show the synthetic source." },
                    { id: "ldh-answer", role: "assistant", content: [{ type: "content", text: "The fixture source is cited here [1]." }], citations: [citation] },
                ],
            } });
            if (path === "/api/chat") return route.fulfill({ json: [chat] });
            if (/\/documents\//.test(path)) {
                uploadedDocumentRequests.push(path);
                return route.fulfill({ status: 404, json: { error: "Not an uploaded document" } });
            }
            return route.fulfill({ json: [] });
        });
        await page.goto("/assistant/chat/ldh-citation");
        await page.getByRole("button", { name: title, exact: true }).click();
        await expect(page.getByRole("link", { name: "Official source", exact: true })).toHaveAttribute("href", "https://example.com/public-source");
        const article = page.getByRole("article");
        await expect(article).toBeVisible();
        await expect(article).toContainText(quote);
        await page.getByRole("button", { name: "Citation 1", exact: true }).first().click();
        await expect(article.locator(".case-quote-highlight")).toHaveText(quote);
        expect(await page.evaluate(() => "ldhInjected" in window)).toBe(false);
        expect(uploadedDocumentRequests).toEqual([]);
        expect(errors).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath(`ldh-${type}-source.png`), animations: "disabled" });
    });
}
