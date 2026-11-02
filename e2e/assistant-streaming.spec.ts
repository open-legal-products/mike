import { expect, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] }, actionTimeout: 30_000 });

// Exercise the real Next/React compiler, message rendering, passive effects and
// animation frames with paced SSE. No provider key or customer data is needed.
// A single buffered response or a short transcript misses this regression.
for (const scope of ["assistant", "project", "tabular"] as const) {
    for (const streamKind of ["content", "reasoning"] as const) {
        test(`long ${scope} conversations can stream ${streamKind} without React update-depth errors`, async ({ page }) => {
            // Leave headroom for the deliberately throttled renderer on CI runners.
            test.setTimeout(600_000);
            const errors: string[] = [];
            page.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
            });
            page.on("pageerror", (error) => errors.push(error.message));
            const cdp = await page.context().newCDPSession(page);
            await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

            await page.addInitScript(({ streamKind, scope }) => {
                const originalFetch = window.fetch.bind(window);
                const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                const json = async (body: unknown) => {
                    await delay(80);
                    return new Response(JSON.stringify(body), {
                        headers: { "Content-Type": "application/json" },
                    });
                };
                const chat = {
                    id: "streaming-regression",
                    title: "Synthetic streaming regression",
                    user_id: "streaming-user",
                    project_id: scope === "project" ? "stress-project" : null,
                    model: "test-model",
                    created_at: "2026-09-29T00:00:00Z",
                    is_owner: true,
                    access_role: "owner",
                };
                let turn = 0;
                window.fetch = (input, init) => {
                    const url = input instanceof Request ? input.url : String(input);
                    const path = new URL(url, location.href).pathname;
                    if (!path.startsWith("/api/")) return originalFetch(input, init);
                    if (path === "/api/auth/session") {
                        return json({ user: { id: "streaming-user", email: "synthetic@example.com" } });
                    }
                    if (path === "/api/user/profile") {
                        return json({ onboardingComplete: true, displayName: "Synthetic", apiKeyStatus: {}, creditsRemaining: 100 });
                    }
                    if (path === "/api/models/configured") {
                        return json({ models: [{ id: "test-model", label: "Test model", source: "Configured" }] });
                    }
                    if (path.startsWith("/api/models/")) return json({ models: [] });
                    const history = () => Array.from({ length: 8 }, (_, i) => [
                        { id: `seed-user-${i}`, role: "user", content: `Seed question ${i}` },
                        { id: `seed-answer-${i}`, role: "assistant", content: [{ type: "content", text:
                            Array.from({ length: 30 }, (_, j) => `Earlier clause ${i}/${j}. **Review** these synthetic terms.\n\n`).join("") }] },
                    ]).flat();
                    if (path === "/api/projects/stress-project") return json({
                        id: "stress-project", name: "Streaming project", documents: [], folders: [],
                        is_owner: true, access_role: "owner", user_id: "streaming-user",
                    });
                    if (path === "/api/projects/stress-project/chats") return json([chat]);
                    if (path === "/api/tabular-review/stress-review") return json({
                        review: { id: "stress-review", title: "Streaming review", columns_config: [],
                            model: "test-model", is_owner: true, access_role: "owner" },
                        rows: [], cells: [], documents: [],
                    });
                    if (path === "/api/tabular-review/stress-review/chats") return json([chat]);
                    if (path === "/api/tabular-review/stress-review/chats/streaming-regression/messages") return json(history());
                    if (path === "/api/chat/streaming-regression") {
                        return json({ chat, is_owner: true, access_role: "owner", messages: history() });
                    }
                    if (["/api/chat", "/api/projects/stress-project/chat", "/api/tabular-review/stress-review/chat"].includes(path) && init?.method === "POST") {
                        const answer = ++turn;
                        const encoder = new TextEncoder();
                        const stream = new ReadableStream({
                            async start(controller) {
                                const send = (event: unknown) => controller.enqueue(
                                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                                );
                                send({ type: "chat_id", chatId: chat.id, assistantMessageId: `answer-${answer}` });
                                send({ type: "reasoning_delta", text: "Reviewing the synthetic question." });
                                await delay(100);
                                send({ type: "reasoning_block_end" });
                                const chunkCount = streamKind === "reasoning" ? (answer <= 2 ? 150 : 24) : 120;
                                for (let chunk = 0; chunk < chunkCount; chunk++) {
                                    send({ type: `${streamKind}_delta`, text: `Sentence ${chunk} in answer ${answer}. **Review** the terms.\n\n` });
                                    await delay(1);
                                }
                                if (streamKind === "reasoning") {
                                    if (answer === 2) await new Promise<void>((resolve) => {
                                        (window as Window & { finishReasoning?: () => void }).finishReasoning = resolve;
                                    });
                                    send({ type: "reasoning_block_end" });
                                    send({ type: "content_delta", text: `Final answer ${answer}.` });
                                }
                                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                                controller.close();
                            },
                        });
                        return Promise.resolve(new Response(stream, {
                            headers: { "Content-Type": "text/event-stream" },
                        }));
                    }
                    if (path === "/api/chat") return json([chat]);
                    return json([]);
                };
            }, { streamKind, scope });

            await page.goto(scope === "project"
                ? "/projects/stress-project/assistant/chat/streaming-regression"
                : scope === "tabular"
                    ? "/tabular-reviews/stress-review?chat=streaming-regression"
                    : "/assistant/chat/streaming-regression");
            const input = page.getByPlaceholder("How can I help?");
            await expect(input).toBeVisible();
            await expect(page.getByRole("button", { name: "Choose model", exact: true }).last()).toHaveAttribute("title", "Choose model — Test model");
            // Continue beyond the customer's eight messages in the same conversation.
            for (let turn = 1; turn <= (streamKind === "reasoning" ? 8 : 4); turn++) {
                await test.step(`Stream follow-up ${turn} in the same conversation`, async () => {
                    await input.fill(`Synthetic follow-up ${turn}`);
                    await input.press("Enter");
                    if (streamKind === "reasoning" && turn === 2) {
                        await page.waitForFunction(() => Boolean((window as Window & { finishReasoning?: () => void }).finishReasoning), undefined, { timeout: 180_000 });
                        const reasoning = page.getByRole("region", { name: "Thought process", exact: true }).last();
                        await expect(reasoning).toContainText("Sentence 149 in answer 2.");
                        await expect(page.getByRole("button", { name: /^(Expand|Minimise) thought process$/ })).toHaveCount(0);
                        await expect.poll(() => reasoning.evaluate((element) =>
                            element.scrollHeight > element.clientHeight && element.clientHeight <= 144,
                        )).toBe(true);
                        await expect(page.getByRole("button", { name: "Scroll to bottom of thought process", exact: true })).toHaveCount(0);
                        const reasoningFade = reasoning.locator("..").locator('[data-slot="reasoning-scroll-fade"]');
                        await expect(reasoningFade).toBeVisible();
                        await expect(reasoningFade).toHaveCSS("backdrop-filter", /^blur\(/);
                        await expect(reasoningFade).toHaveCSS("pointer-events", "none");
                        await reasoning.focus();
                        await page.keyboard.press("End");
                        await expect.poll(() => reasoning.evaluate((element) =>
                            element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
                        )).toBe(true);
                        await expect(reasoningFade).toBeHidden();
                        await expect(reasoning).toBeFocused();
                        await page.setViewportSize({ width: 480, height: 720 });
                        await expect.poll(() => reasoning.evaluate((element) =>
                            element.scrollHeight > element.clientHeight && element.clientHeight <= 144,
                        )).toBe(true);
                        await reasoning.focus();
                        await page.keyboard.press("Home");
                        await expect.poll(() => reasoning.evaluate((element) => element.scrollTop)).toBe(0);
                        await expect(reasoningFade).toBeVisible();
                        await page.keyboard.press("End");
                        await expect(reasoningFade).toBeHidden();
                        const disclosure = page.getByRole("button", { name: /^(Thinking|Pondering|Analyzing|Reviewing|Reasoning)\.\.\.$/ }).last();
                        await disclosure.click();
                        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
                        await expect(reasoning).toBeHidden();
                        await disclosure.click();
                        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
                        await expect(reasoning).toBeVisible();
                        await expect(reasoningFade).toBeVisible();
                        await page.setViewportSize({ width: 1280, height: 720 });
                        await page.evaluate(() => (window as Window & { finishReasoning?: () => void }).finishReasoning?.());
                    }
                    await expect(page.getByText(streamKind === "reasoning" ? `Final answer ${turn}.` : `Sentence 119 in answer ${turn}.`, { exact: false })).toBeVisible({ timeout: 180_000 });
                    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
                    expect(errors, `Browser errors after follow-up ${turn}`).toEqual([]);
                });
            }

            if (scope === "assistant") {
                const content = page.locator('[data-slot="chat-messages-content"]');
                await content.evaluate((element) => {
                    const viewport = element.parentElement!;
                    viewport.scrollTop = 0;
                    viewport.dispatchEvent(new Event("scroll"));
                });
                await expect(page.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeVisible();
                await page.getByRole("button", { name: "Scroll to bottom", exact: true }).click();
                await expect(page.getByRole("button", { name: "Scroll to bottom", exact: true })).toBeHidden();
            }
            expect(errors).toEqual([]);
        });
    }
}

// Use the actual chat renderer and stream adapter, with synthetic search results.
// The screenshots also provide review evidence for the new pre-response activity.
test("scoped document search activity streams, renders mocked history after reload, and fits narrow screens", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
        const originalFetch = window.fetch.bind(window);
        const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), {
            headers: { "Content-Type": "application/json" },
        }));
        const chat = { id: "search-activity", title: "Change of control review", user_id: "search-user",
            model: "claude-sonnet-5-5", created_at: "2026-10-15T00:00:00Z", is_owner: true, access_role: "owner" };
        const search = { type: "doc_search", search_id: "search-1", scope: "library", query: "change of control",
            offset: 0, match_count: 3, next_offset: null,
            coverage: { total_versions: 24, indexed_versions: 20, pending_versions: 3, failed_versions: 1, versions_needing_ocr: 2 } };
        const answer = "I found three matching documents. Search coverage is incomplete, so other documents may also contain this clause.";
        const prompt = "Find documents containing a change of control clause in my document library.";
        window.fetch = (input, init) => {
            const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
            if (!path.startsWith("/api/")) return originalFetch(input, init);
            if (path === "/api/auth/session") return json({ user: { id: "search-user", email: "preview@example.test" } });
            if (path === "/api/user/profile") return json({ onboardingComplete: true, displayName: "Alex", lastSelectedChatModel: "claude-sonnet-5-5", apiKeyStatus: { claude: true }, creditsRemaining: 100 });
            if (path === "/api/models/configured") return json({ models: [] });
            if (path === "/api/chat/search-activity") return json({ chat, is_owner: true, access_role: "owner",
                messages: sessionStorage.getItem("search-complete") ? [
                    { id: "question-1", role: "user", content: prompt },
                    { id: "answer-1", role: "assistant", content: [search, { type: "content", text: answer }] },
                ] : [] });
            if (path === "/api/chat" && init?.method === "POST") {
                const encoder = new TextEncoder();
                return Promise.resolve(new Response(new ReadableStream({ async start(controller) {
                    const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                    send({ type: "chat_id", chatId: chat.id, assistantMessageId: "answer-1" });
                    send({ type: "tool_call_start", name: "find_documents" });
                    send({ type: "doc_search_start", search_id: search.search_id, scope: search.scope, query: search.query, offset: 0 });
                    await new Promise<void>(resolve => {
                        (window as Window & { completeDocumentSearch?: () => void }).completeDocumentSearch = resolve;
                    });
                    send(search);
                    send({ type: "content_delta", text: answer });
                    sessionStorage.setItem("search-complete", "true");
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                } }), { headers: { "Content-Type": "text/event-stream" } }));
            }
            if (path === "/api/chat") return json([chat]);
            return json([]);
        };
    });
    await page.goto("/assistant/chat/search-activity");
    const input = page.getByPlaceholder("How can I help?");
    await expect(page.getByRole("button", { name: "Choose model", exact: true })).toHaveAttribute("title", "Choose model — Claude Sonnet 5.5");
    await input.fill("Find documents containing a change of control clause in my document library.");
    await input.press("Enter");
    await expect(page.getByRole("button", { name: /^Searching the document library for “change of control”\s*\.\.\.$/ })).toBeVisible();
    const progress = testInfo.outputPath("document-search-progress.png");
    await page.screenshot({ path: progress });
    await testInfo.attach("Document search in progress", { path: progress, contentType: "image/png" });
    await page.evaluate(() => (window as Window & { completeDocumentSearch?: () => void }).completeDocumentSearch?.());
    await expect(page.getByRole("button", { name: "Stop response", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Completed in 1 step", exact: true }).click();
    await page.getByRole("button", { name: /Searched the document library/ }).click();
    await expect(page.getByText("3 matches", { exact: true })).toBeVisible();
    await expect(page.getByText(/20 of 24 document versions searchable/)).toHaveCount(0);
    const completed = testInfo.outputPath("document-search-completed.png");
    await page.screenshot({ path: completed });
    await testInfo.attach("Document search dropdown and match count", { path: completed, contentType: "image/png" });
    await page.reload();
    await page.getByRole("button", { name: "Completed in 1 step", exact: true }).click();
    await page.getByRole("button", { name: /Searched the document library/ }).click();
    await expect(page.getByText("3 matches", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText(/20 of 24 document versions searchable/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const mobile = testInfo.outputPath("document-search-mobile.png");
    await page.screenshot({ path: mobile });
    await testInfo.attach("Document search narrow layout", { path: mobile, contentType: "image/png" });
    expect(errors).toEqual([]);
});
