import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

vi.mock("@/app/components/shared/GoogleWorkspaceActionCard", () => ({
    InlineGoogleWorkspaceAction: ({ actionId }: { actionId: string }) => (
        <div>Inline Google approval {actionId}</div>
    ),
}));

const reasoning = (text: string): AssistantEvent => ({
    type: "reasoning",
    text,
});

describe("AssistantMessage timeline", () => {
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

    it("keeps a Google approval visible in the assistant flow", () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "mcp_tool_call",
                        connector_id: "gmail-native",
                        connector_name: "Gmail",
                        tool_name: "gmail_propose_send",
                        openai_tool_name: "gmail_propose_send",
                        status: "ok",
                        google_action_id: "action-1",
                    },
                    {
                        type: "content",
                        text: "Review the exact email before it is sent.",
                    },
                ]}
            />,
        );

        expect(screen.getByText("Inline Google approval action-1")).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        ).toHaveAttribute("aria-expanded", "true");
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
