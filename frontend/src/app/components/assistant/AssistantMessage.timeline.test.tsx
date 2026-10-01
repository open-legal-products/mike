import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

const approvalRequest: AssistantEvent = {
    type: "ask_inputs",
    event_id: "ask-1",
    items: [
        {
            id: "approve-1",
            kind: "approval",
            connector_name: "Gmail",
            tool_name: "gmail_send",
            title: "Send email",
            arguments: { to: ["a@example.com"], subject: "Hi", body: "Body" },
            binding: { type: "google", provider: "gmail", grant_id: "g1" },
        },
    ],
};

const reasoning = (text: string): AssistantEvent => ({
    type: "reasoning",
    text,
});

describe("AssistantMessage timeline", () => {
    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            disconnect() {}
        });
    });
    afterEach(() => vi.unstubAllGlobals());
    it("folds a run of reasoning events into one thinking block", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("First I check the parties."),
                    reasoning("Then the termination clause."),
                    reasoning("Finally the governing law."),
                ]}
            />,
        );

        // One block, not three stacked on the timeline.
        const toggles = screen.getAllByRole("button", {
            name: /Thought process/,
        });
        expect(toggles).toHaveLength(1);

        fireEvent.click(toggles[0]);
        expect(screen.getByText(/First I check the parties/)).toBeVisible();
        expect(screen.getByText(/Then the termination clause/)).toBeVisible();
        expect(screen.getByText(/Finally the governing law/)).toBeVisible();
    });

    it("keeps reasoning separated by other work in its own blocks", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("Before the search."),
                    {
                        type: "doc_read",
                        filename: "lease.pdf",
                        document_id: "d1",
                        version_id: "v1",
                        version_number: 1,
                    },
                    reasoning("After the search."),
                ]}
            />,
        );

        expect(
            screen.getAllByRole("button", { name: /Thought process/ }),
        ).toHaveLength(2);
    });

    it("does not mark the response failed when a single tool call fails", () => {
        const { container } = render(
            <AssistantMessage
                events={[
                    {
                        type: "mcp_tool_call",
                        connector_id: "c1",
                        connector_name: "Drive",
                        tool_name: "search",
                        openai_tool_name: "drive_search",
                        status: "error",
                        error: "Connector unavailable",
                    },
                    { type: "content", text: "Here is what I found anyway." },
                ]}
            />,
        );

        // The response is not branded an error…
        expect(
            screen.queryByText("Sorry, something went wrong."),
        ).not.toBeInTheDocument();

        // …while the failed step still reports itself once the steps are open.
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(container.querySelector(".bg-red-400")).not.toBeNull();
        expect(screen.getByText("Connector unavailable")).toBeInTheDocument();
    });

    it("keeps a pending connector approval open in the assistant flow", () => {
        render(<AssistantMessage events={[approvalRequest]} />);

        expect(screen.getByText("Asking for approval")).toBeVisible();
        expect(screen.getByText("Gmail: Send email")).toBeVisible();
    });

    it("records the decision and the approved action's result", () => {
        render(
            <AssistantMessage
                events={[
                    approvalRequest,
                    {
                        type: "ask_inputs_response",
                        assistant_message_id: "m1",
                        ask_event_id: "ask-1",
                        responses: [
                            {
                                id: "approve-1",
                                kind: "approval",
                                decision: "approve",
                            },
                        ],
                    },
                    {
                        type: "mcp_tool_call",
                        connector_id: "gmail-native",
                        connector_name: "Gmail",
                        tool_name: "gmail_send",
                        openai_tool_name: "gmail_send",
                        status: "ok",
                        approval_id: "approve-1",
                    },
                    { type: "content", text: "Sent." },
                ]}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 2 steps" }),
        );
        fireEvent.click(screen.getByText("Asked for approval"));
        expect(screen.getByText("Approved")).toBeVisible();
        expect(screen.getByText("Gmail: gmail_send")).toBeVisible();
    });

    it("marks the response failed for a top-level error event", () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "error",
                        message: "The response was interrupted.",
                        safe_to_display: true,
                    } as AssistantEvent,
                ]}
            />,
        );

        expect(
            screen.getByText("The response was interrupted."),
        ).toBeInTheDocument();
    });
});
