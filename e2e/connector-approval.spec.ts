import { expect, test } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

// A connector that asks for permission pauses the assistant turn on an
// approval, exactly like a question. The real chat page renders the pending
// action, sends only the decision, and continues the same turn with the
// streamed result. Synthetic data; no connector or provider is contacted.
for (const liveConnector of [false, "calendar", "drive"] as const) {
  for (const width of [390, 1280]) {
    test(`${liveConnector === "drive" ? "Live Drive rename" : liveConnector ? "Live calendar edit" : "Restored Gmail"} approval continues the turn at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((liveConnector) => {
        const json = (body: unknown) =>
          Promise.resolve(
            new Response(JSON.stringify(body), {
              headers: { "Content-Type": "application/json" },
            }),
          );
        const chat = {
          id: "approval-chat",
          title:
            liveConnector === "drive"
              ? "Rename agreement"
              : liveConnector
                ? "Reschedule a meeting"
                : "Send the NDA",
          user_id: "approval-user",
          project_id: null,
          model: "test-model",
          created_at: "2026-10-01T00:00:00Z",
          is_owner: true,
          access_role: "owner",
        };
        const approval = {
          type: "ask_inputs",
          event_id: "ask-1",
          items: [
            liveConnector
              ? {
                  id: "approve-calendar",
                  kind: "approval",
                  connector_name: "Google Calendar",
                  tool_name: "google_calendar_update_event",
                  title: "Update event",
                  arguments: {
                    calendar_id: "primary",
                    event_id: "event-1",
                    start: { dateTime: "2026-10-01T15:00:00+08:00" },
                    end: { dateTime: "2026-10-01T16:00:00+08:00" },
                  },
                  before: {
                    summary: "Client meeting",
                    location: "Original meeting room",
                  },
                  account: "me@example.com",
                  binding: {
                    type: "google",
                    provider: "google-calendar",
                    grant_id: "g1",
                    etag: "before-edit",
                  },
                }
              : {
                  id: "approve-send",
                  kind: "approval",
                  connector_name: "Gmail",
                  tool_name: "gmail_send",
                  title: "Send email",
                  arguments: {
                    to: [
                      "opposing.counsel.with.a.long.mailbox@example-law-firm.com",
                    ],
                    subject: "Mutual NDA — execution version",
                    body: "Please find the execution version attached.\n\nKind regards",
                  },
                  account: "me@example.com",
                  binding: {
                    type: "google",
                    provider: "gmail",
                    grant_id: "g1",
                  },
                },
          ],
        };
        if (liveConnector === "drive") {
          Object.assign(approval.items[0], {
            id: "approve-drive",
            connector_name: "Google Drive",
            tool_name: "google_drive_update_file",
            title: "Rename file",
            arguments: { file_id: "file-1", name: "Final agreement" },
            before: {
              file: { id: "file-1", name: "Original agreement", version: "1" },
            },
            binding: {
              type: "google",
              provider: "google-drive",
              grant_id: "g1",
            },
          });
        }
        const sent: unknown[] = [];
        (window as Window & { sentBodies?: unknown[] }).sentBodies = sent;
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          const path = new URL(url, location.href).pathname;
          if (!path.startsWith("/api/")) return originalFetch(input, init);
          if (path === "/api/auth/session")
            return json({
              user: { id: "approval-user", email: "synthetic@example.com" },
            });
          if (path === "/api/user/profile")
            return json({
              onboardingComplete: true,
              displayName: "Synthetic",
              apiKeyStatus: {},
              creditsRemaining: 100,
            });
          if (path === "/api/models/configured")
            return json({
              models: [
                { id: "test-model", label: "Test model", source: "Configured" },
              ],
            });
          if (path.startsWith("/api/models/")) return json({ models: [] });
          if (path === "/api/chat/approval-chat")
            return json({
              chat,
              is_owner: true,
              access_role: "owner",
              messages: liveConnector
                ? [
                    {
                      id: "user-0",
                      role: "user",
                      content:
                        liveConnector === "drive"
                          ? "Find my draft agreement."
                          : "Find my client meeting.",
                    },
                    {
                      id: "assistant-0",
                      role: "assistant",
                      content: [
                        {
                          type: "content",
                          text:
                            liveConnector === "drive"
                              ? "I found your draft agreement."
                              : "I found your client meeting.",
                        },
                      ],
                    },
                  ]
                : [
                    {
                      id: "user-1",
                      role: "user",
                      content: "Email the NDA to opposing counsel.",
                    },
                    {
                      id: "assistant-1",
                      role: "assistant",
                      content: [
                        {
                          type: "content",
                          text: "I'll send it once you approve.",
                        },
                        approval,
                      ],
                    },
                  ],
            });
          if (path === "/api/chat" && init?.method === "POST") {
            sent.push(JSON.parse(String(init.body)));
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
              start(controller) {
                const send = (event: unknown) =>
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                  );
                send({
                  type: "chat_id",
                  chatId: chat.id,
                  turnId: "turn-2",
                  assistantMessageId: "assistant-1",
                });
                const item = approval.items[0];
                if (liveConnector && sent.length === 1) {
                  // The edit pauses with no prose. The live SSE consumer must
                  // retain its approval instead of making the turn disappear.
                  send({ type: "tool_call_start", name: item.tool_name });
                  send(approval);
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                  return;
                }
                send({ type: "mcp_tool_start", name: item.tool_name });
                send({
                  type: "mcp_tool_result",
                  name: item.tool_name,
                  connector_name: item.connector_name,
                  tool_name: item.tool_name,
                  status: "ok",
                  approval_id: item.id,
                });
                send({
                  type: "content_delta",
                  text: liveConnector
                    ? liveConnector === "drive"
                      ? "Renamed the file."
                      : "Moved the meeting to 3 pm."
                    : "Sent the NDA.",
                });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              },
            });
            return Promise.resolve(
              new Response(stream, {
                headers: { "Content-Type": "text/event-stream" },
              }),
            );
          }
          if (path === "/api/chat") return json([chat]);
          return json([]);
        };
      }, liveConnector);

      await page.goto("/assistant/chat/approval-chat");
      if (liveConnector) {
        const input = page.getByPlaceholder("How can I help?");
        await expect(
          page
            .getByRole("button", { name: "Choose model", exact: true })
            .last(),
        ).toHaveAttribute("title", "Choose model — Test model");
        await input.fill(
          liveConnector === "drive"
            ? "Rename the draft to Final agreement."
            : "Move the client meeting to 3 pm.",
        );
        await input.press("Enter");
      }
      const card = page.getByRole("article", {
        name: liveConnector
          ? liveConnector === "drive"
            ? "Rename file on Google Drive"
            : "Update event on Google Calendar"
          : "Send email on Gmail",
      });
      await expect(card).toBeVisible();
      await expect(
        card.getByText(
          `${liveConnector === "drive" ? "Google Drive" : liveConnector ? "Google Calendar" : "Gmail"} · me@example.com`,
        ),
      ).toBeVisible();
      if (liveConnector === "drive") {
        await card.getByText("Current item before this change").click();
        await expect(card.getByText(/Original agreement/)).toBeVisible();
      } else if (liveConnector) {
        await expect(
          card.getByText("Date and time: 2026-10-01T15:00:00+08:00", {
            exact: true,
          }),
        ).toBeVisible();
        await card.getByText("Current item before this change").click();
        await expect(card.getByText(/Original meeting room/)).toBeVisible();
      } else {
        await expect(
          card.getByText(
            "opposing.counsel.with.a.long.mailbox@example-law-firm.com",
          ),
        ).toBeVisible();
      }
      const cardBounds = await card.evaluate((element) => ({
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        overflow: element.scrollWidth - element.clientWidth,
      }));
      expect(cardBounds.left).toBeGreaterThanOrEqual(0);
      expect(cardBounds.right).toBeLessThanOrEqual(width);
      expect(cardBounds.overflow).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: testInfo.outputPath("approval-pending.png"),
        animations: "disabled",
      });

      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(
        page.getByText(
          liveConnector
            ? liveConnector === "drive"
              ? "Renamed the file."
              : "Moved the meeting to 3 pm."
            : "Sent the NDA.",
        ),
      ).toBeVisible();
      const sent = await page.evaluate(
        () => (window as Window & { sentBodies?: unknown[] }).sentBodies,
      );
      expect(sent).toHaveLength(liveConnector ? 2 : 1);
      // Only the decision travels; the server runs the action it stored.
      expect(sent!.at(-1)).toMatchObject({
        chat_id: "approval-chat",
        ask_inputs_response: {
          assistant_message_id: "assistant-1",
          ask_event_id: "ask-1",
          responses: [
            {
              id:
                liveConnector === "drive"
                  ? "approve-drive"
                  : liveConnector
                    ? "approve-calendar"
                    : "approve-send",
              kind: "approval",
              decision: "approve",
            },
          ],
        },
      });
      expect(JSON.stringify(sent!.at(-1))).not.toContain(
        "execution version attached",
      );
      if (liveConnector)
        expect(JSON.stringify(sent!.at(-1))).not.toContain("before-edit");
      await expect(card).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath("approval-done.png"),
        animations: "disabled",
      });
    });
  }
}
