import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskInputPopup } from "./AskInputPopup";

describe("AskInputPopup", () => {
    it("submits an open-ended answer entered in a textarea", async () => {
        const onSubmit = vi.fn();
        render(
            <AskInputPopup
                assistantMessageId="assistant-1"
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [
                        {
                            id: "registered-address",
                            kind: "text",
                            question: "What is the registered address?",
                        },
                    ],
                }}
                onSubmit={onSubmit}
            />,
        );

        const input = screen.getByRole("textbox", {
            name: "What is the registered address?",
        });
        expect(input.tagName).toBe("TEXTAREA");
        expect(input.closest(".liquid-glass-translucent")).not.toBeNull();
        expect(input).toHaveAttribute("maxlength", "5000");
        expect(screen.getByText("0 / 5,000")).toBeInTheDocument();

        fireEvent.change(input, {
            target: { value: "x".repeat(5_001) },
        });
        expect(input).toHaveValue("x".repeat(5_000));
        expect(screen.getByText("5,000 / 5,000")).toBeInTheDocument();

        fireEvent.change(input, {
            target: { value: "1 Legal Plaza\nSingapore 048583" },
        });
        expect(screen.getByText("30 / 5,000")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toEqual({
            type: "ask_inputs_response",
            assistant_message_id: "assistant-1",
            ask_event_id: "ask-1",
            responses: [
                {
                    id: "registered-address",
                    kind: "text",
                    question: "What is the registered address?",
                    answer: "1 Legal Plaza\nSingapore 048583",
                },
            ],
        });
        expect(onSubmit.mock.calls[0][1]).toContain(
            "1 Legal Plaza\nSingapore 048583",
        );
        expect(onSubmit.mock.calls[0][2]).toEqual([]);
    });

    it("requires confirmation again after a confirmed answer is edited", async () => {
        const onSubmit = vi.fn();
        render(
            <AskInputPopup
                assistantMessageId="assistant-1"
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [
                        {
                            id: "name",
                            kind: "text",
                            question: "What is the company name?",
                        },
                        {
                            id: "address",
                            kind: "text",
                            question: "What is the registered address?",
                        },
                    ],
                }}
                onSubmit={onSubmit}
            />,
        );

        fireEvent.change(
            screen.getByRole("textbox", {
                name: "What is the company name?",
            }),
            { target: { value: "Old Name" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        fireEvent.click(screen.getAllByRole("button", { name: "Question" })[0]);
        const nameInput = screen.getByRole("textbox", {
            name: "What is the company name?",
        });
        fireEvent.change(nameInput, { target: { value: "New Name" } });
        expect(
            screen.getByRole("button", { name: "Confirm" }),
        ).toBeEnabled();
        expect(onSubmit).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        fireEvent.change(
            screen.getByRole("textbox", {
                name: "What is the registered address?",
            }),
            { target: { value: "1 Legal Plaza" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0].responses[0]).toMatchObject({
            id: "name",
            answer: "New Name",
        });
    });

    it("allows multiple options to be selected and returned together", async () => {
        const onSubmit = vi.fn();
        render(
            <AskInputPopup
                assistantMessageId="assistant-1"
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [
                        {
                            id: "clauses",
                            kind: "multi_choice",
                            question: "Which optional clauses should be included?",
                            options: [
                                { value: "Audit rights" },
                                { value: "Non-solicitation" },
                                { value: "Exclusivity" },
                            ],
                            allow_other: false,
                            other_label: "Other",
                        },
                    ],
                }}
                onSubmit={onSubmit}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: /Audit rights/ }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: /Non-solicitation/ }),
        );
        expect(
            screen.getByRole("button", { name: /Audit rights/ }),
        ).toHaveAttribute("aria-pressed", "true");
        expect(
            screen.getByRole("button", { name: /Non-solicitation/ }),
        ).toHaveAttribute("aria-pressed", "true");

        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toEqual({
            type: "ask_inputs_response",
            assistant_message_id: "assistant-1",
            ask_event_id: "ask-1",
            responses: [
                {
                    id: "clauses",
                    kind: "multi_choice",
                    question: "Which optional clauses should be included?",
                    answers: ["Audit rights", "Non-solicitation"],
                },
            ],
        });
        expect(onSubmit.mock.calls[0][1]).toContain(
            "Audit rights, Non-solicitation",
        );
    });

    const sendEmail = {
        id: "approve-send",
        kind: "approval" as const,
        connector_name: "Gmail",
        tool_name: "gmail_send",
        title: "Send email",
        arguments: {
            to: ["counsel@example.com"],
            subject: "Draft NDA",
            body: "Please review.",
        },
        account: "me@example.com",
        binding: {
            type: "google" as const,
            provider: "gmail" as const,
            grant_id: "g1",
        },
    };
    const postMessage = {
        id: "approve-post",
        kind: "approval" as const,
        connector_name: "Slack",
        tool_name: "mcp_slack_post",
        title: "Post message",
        arguments: { channel: "legal", text: "NDA sent" },
        binding: {
            type: "mcp" as const,
            connector_id: "c1",
            tool_id: "t1",
        },
    };

    it("shows the exact connector action and submits an approval decision", async () => {
        const onSubmit = vi.fn();
        render(
            <AskInputPopup
                assistantMessageId="assistant-1"
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [sendEmail],
                }}
                onSubmit={onSubmit}
            />,
        );

        expect(screen.getByText("Approval")).toBeInTheDocument();
        expect(screen.getByText("Send email")).toBeInTheDocument();
        expect(screen.getByText("Gmail · me@example.com")).toBeInTheDocument();
        expect(screen.getByText("counsel@example.com")).toBeInTheDocument();
        expect(screen.getByText("Please review.")).toBeInTheDocument();
        // An approval has no Skip: rejecting is the way to decline.
        expect(
            screen.queryByRole("button", { name: "Skip" }),
        ).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Approve" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0]).toEqual({
            type: "ask_inputs_response",
            assistant_message_id: "assistant-1",
            ask_event_id: "ask-1",
            responses: [
                { id: "approve-send", kind: "approval", decision: "approve" },
            ],
        });
        expect(onSubmit.mock.calls[0][1]).toBe(
            "Decisions on Mike's requested actions:\n1. Approved: Send email (Gmail)",
        );
    });

    it("collects a decision for every pending action before submitting", async () => {
        const onSubmit = vi.fn();
        render(
            <AskInputPopup
                assistantMessageId="assistant-1"
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [sendEmail, postMessage],
                }}
                onSubmit={onSubmit}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Reject" }));
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getByText("Post message")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Approve" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0].responses).toEqual([
            { id: "approve-send", kind: "approval", decision: "reject" },
            { id: "approve-post", kind: "approval", decision: "approve" },
        ]);
    });
});


it("caps Other choice answers at the backend limit", () => {
    const onSubmit = vi.fn();
    render(<AskInputPopup assistantMessageId="assistant-1" event={{ type: "ask_inputs", event_id: "ask-1", items: [{ id: "a", kind: "choice", question: "Which option?", options: [{ value: "Option A" }], allow_other: true, other_label: "Other" }] }} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText("Other"));
    const input = screen.getByRole("textbox", { name: "Other" });
    expect(input).toHaveAttribute("maxlength", "1000");
    fireEvent.change(input, { target: { value: "x".repeat(1001) } });
    expect(input).toHaveValue("x".repeat(1000));
    expect(screen.getByText("1,000 / 1,000")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onSubmit.mock.calls[0][0].responses[0].answer).toHaveLength(1000);
});
