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
                        await page.getByRole("button", { name: "Expand thought process", exact: true }).last().click();
                        await page.setViewportSize({ width: 480, height: 720 });
                        await page.getByRole("button", { name: "Minimise thought process", exact: true }).last().click();
                        const disclosure = page.getByRole("button", { name: /^(Thinking|Pondering|Analyzing|Reviewing|Reasoning)\.\.\.$/ }).last();
                        await disclosure.click();
                        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
                        await disclosure.click();
                        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
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
