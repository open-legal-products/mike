import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { AskInputPopup } from "./AskInputPopup";

describe("AskInputPopup", () => {
    it("submits an open-ended answer entered in a textarea", async () => {
        const onSubmit = vi.fn();
        render(
             withIntl(<AskInputPopup
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
            />),
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
        fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

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
             withIntl(<AskInputPopup
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
            />),
        );

        fireEvent.change(
            screen.getByRole("textbox", {
                name: "What is the company name?",
            }),
            { target: { value: "Old Name" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

        fireEvent.click(screen.getAllByRole("button", { name: "Pergunta" })[0]);
        const nameInput = screen.getByRole("textbox", {
            name: "What is the company name?",
        });
        fireEvent.change(nameInput, { target: { value: "New Name" } });
        expect(
            screen.getByRole("button", { name: "Confirmar" }),
        ).toBeEnabled();
        expect(onSubmit).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

        fireEvent.change(
            screen.getByRole("textbox", {
                name: "What is the registered address?",
            }),
            { target: { value: "1 Legal Plaza" } },
        );
        fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
        expect(onSubmit.mock.calls[0][0].responses[0]).toMatchObject({
            id: "name",
            answer: "New Name",
        });
    });

    it("allows multiple options to be selected and returned together", async () => {
        const onSubmit = vi.fn();
        render(
             withIntl(<AskInputPopup
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
            />),
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

        fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));

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
});
