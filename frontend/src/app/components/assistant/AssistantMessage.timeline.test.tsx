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
    it("places read-only text cards between surrounding prose, outside collapsed activity", () => {
        render(<AssistantMessage events={[
            { type: "content", text: "Here is your draft." },
            reasoning("Preparing the wording."),
            { type: "text_card", card_id: "card-1", title: "Email", text: "Dear Alex," },
            { type: "content", text: "You can also use this version." },
            { type: "text_card", card_id: "card-2", title: "Alternative", text: "Hello Alex," },
            { type: "content", text: "Adjust the greeting." },
        ]} />);
        const ordered = [screen.getByText("Here is your draft."), screen.getByRole("region", { name: "Email" }), screen.getByText("You can also use this version."), screen.getByRole("region", { name: "Alternative" }), screen.getByText("Adjust the greeting.")];
        ordered.forEach((element, index) => {
            expect(element).toBeVisible();
            if (index) expect(ordered[index - 1].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });
        expect(screen.queryByRole("textbox")).toBeNull();
    });
    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            disconnect() {}
        });
    });
    afterEach(() => vi.unstubAllGlobals());
    it("hides the copy button while it waits for input or approval", () => {
        const { rerender } = render(
            <AssistantMessage events={[approvalRequest]} awaitingInput />,
        );

        // Nothing has been delivered yet, so there is nothing to copy.
        expect(
            screen.queryByRole("button", { name: "Copy response" }),
        ).toBeNull();

        // Once the request is settled the message is an ordinary one again.
        rerender(<AssistantMessage events={[approvalRequest]} />);
        expect(
            screen.getByRole("button", { name: "Copy response" }),
        ).toBeInTheDocument();
    });

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

    it("marks a successful connector call green and a failed one red", () => {
        const call = (status: "ok" | "error"): AssistantEvent => ({
            type: "mcp_tool_call",
            connector_id: "c1",
            connector_name: "Drive",
            tool_name: "search",
            openai_tool_name: "drive_search",
            status,
            ...(status === "error" ? { error: "Connector unavailable" } : {}),
        });
        const { container, unmount } = render(
            <AssistantMessage
                events={[call("ok"), { type: "content", text: "Found it." }]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(container.querySelector(".bg-green-400")).not.toBeNull();
        expect(container.querySelector(".bg-red-400")).toBeNull();
        expect(container.querySelector(".bg-gray-500")).toBeNull();
        // The connector step carries a decorative svg icon beside its label.
        const icon = screen.getByTestId("connector-event-icon");
        expect(icon.getAttribute("src")).toContain(
            "/icons/features/connector.svg",
        );
        expect(icon).toHaveAttribute("aria-hidden", "true");
        expect(icon.parentElement).toHaveTextContent("Drive: Search");
        unmount();

        const failed = render(
            <AssistantMessage
                events={[call("error"), { type: "content", text: "Sorry." }]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(failed.container.querySelector(".bg-red-400")).not.toBeNull();
        expect(failed.container.querySelector(".bg-green-400")).toBeNull();
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
        expect(screen.getByText("Gmail: Gmail send")).toBeVisible();
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

    describe("delegation", () => {
        const delegation = (
            overrides: Partial<Extract<AssistantEvent, { type: "delegation" }>> = {},
        ): AssistantEvent => ({
            type: "delegation",
            delegation_id: "d1",
            title: "Review the lease",
            task: "List every rent review clause in lease.pdf.",
            status: "completed",
            brief: "Clause 4.2 sets an annual review.",
            events: [
                { type: "doc_read", filename: "lease.pdf" },
                { type: "case_citation", cluster_id: 1, case_name: null, citation: null, url: "" },
            ],
            model: "claude-haiku-4-5",
            effort: "standard",
            usage: { input_tokens: 1000, output_tokens: 200 },
            ...overrides,
        });
        const openSteps = () =>
            fireEvent.click(screen.getByRole("button", { name: "Completed in 1 step" }));

        it("opens to the task, the subagent's steps and its brief", () => {
            render(<AssistantMessage events={[delegation(), { type: "content", text: "Done." }]} />);
            openSteps();
            expect(screen.queryByText(/List every rent review clause/)).toBeNull();

            fireEvent.click(screen.getByRole("button", { name: /^Delegated\s*Review the lease$/ }));
            expect(screen.getByText(/List every rent review clause/)).toBeVisible();
            expect(screen.getByText("lease.pdf")).toBeVisible();

            fireEvent.click(screen.getByRole("button", { name: "Returned a brief" }));
            expect(screen.getByRole("region", { name: "Brief" }))
                .toHaveTextContent("Clause 4.2 sets an annual review.");
        });

        it.each([
            [{}, "Delegated", null],
            [{ status: "incomplete" as const }, "Delegation incomplete", /Partial brief/],
            [{ status: "cancelled" as const }, "Delegation stopped", null],
            [
                { status: "needs_input" as const, question: "Which lease, the 2019 or the 2021 one?" },
                "Asked for input",
                null,
            ],
            [{ status: "needs_input" as const, approval_ids: ["approve-1"] }, "Asking for approval", null],
        ])("reports how the subagent ended", (overrides, label, meta) => {
            render(<AssistantMessage events={[delegation(overrides), { type: "content", text: "Done." }]} />);
            openSteps();
            expect(screen.getByRole("button", { name: new RegExp(`^${label}\\s*Review the lease$`) })).toBeVisible();
            if (meta) expect(screen.getByText(meta)).toBeVisible();
        });

        it("finds a nested citation check's cases among the subagent's own steps", () => {
            render(
                <AssistantMessage
                    events={[
                        delegation({
                            events: [
                                { type: "courtlistener_verify_citations", citation_count: 1, match_count: 1 },
                                { type: "case_citation", cluster_id: 7, case_name: "Roe v. Wade", citation: "410 U.S. 113", url: "" },
                            ],
                        }),
                        { type: "content", text: "Done." },
                    ]}
                />,
            );
            openSteps();
            fireEvent.click(screen.getByRole("button", { name: /^Delegated\s*Review the lease$/ }));
            fireEvent.click(screen.getByRole("button", { name: /Verified 1 citation/ }));
            expect(screen.getByText("Roe v. Wade, 410 U.S. 113")).toBeVisible();
        });
    });
});
