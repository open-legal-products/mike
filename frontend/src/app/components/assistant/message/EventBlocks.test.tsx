import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { withIntl } from "@/test/withIntl";
import {
    AskInputsBlock,
    CourtListenerBlock,
    DocDownloadBlock,
} from "./EventBlocks";

describe("DocDownloadBlock", () => {
    it("shows the file icon without a file-type label", () => {
        const { container } = render(
            <DocDownloadBlock
                filename="agreement.docx"
                download_url="/documents/agreement/download"
                versionNumber={2}
            />,
        );

        expect(screen.getByText("agreement")).toHaveClass("text-lg");
        expect(screen.queryByText("DOCX")).not.toBeInTheDocument();
        expect(
            container.querySelector(
                'img[src*="/icons/file-types/word.svg"]',
            ),
        ).toHaveClass("h-4", "w-4");
    });
});

describe("AskInputsBlock", () => {
    it("collapses completed input details and toggles them from the label", () => {
        render(
            withIntl(<AskInputsBlock
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [
                        {
                            id: "address",
                            kind: "text",
                            question: "What is the registered address?",
                        },
                    ],
                }}
                response={{
                    type: "ask_inputs_response",
                    assistant_message_id: "assistant-1",
                    ask_event_id: "ask-1",
                    responses: [
                        {
                            id: "address",
                            kind: "text",
                            question: "What is the registered address?",
                            answer: "1 Legal Plaza",
                        },
                    ],
                }}
            />),
        );

        const toggle = screen.getByRole("button", {
            name: "Solicitou entradas",
        });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByText("What is the registered address?"),
        ).not.toBeInTheDocument();

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByText("What is the registered address?"),
        ).toBeInTheDocument();
        expect(screen.getByText("1 Legal Plaza")).toBeInTheDocument();

        fireEvent.click(toggle);
        expect(
            screen.queryByText("What is the registered address?"),
        ).not.toBeInTheDocument();
    });
});

describe("event line consistency", () => {
    it("uses one chevron direction and always reports expansion", () => {
        const { container, unmount } = render(
            withIntl(<AskInputsBlock
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [
                        {
                            id: "venue",
                            kind: "text",
                            question: "Which venue?",
                        },
                    ],
                }}
            />),
        );

        // Unanswered blocks open by default: chevron down, nothing rotated.
        const toggle = screen.getByRole("button", { name: "Solicitando entradas" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(container.querySelector("svg.-rotate-90")).toBeNull();

        // Closed points right — the direction every other block uses.
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(container.querySelector("svg.-rotate-90")).not.toBeNull();
        unmount();

        const research = render(
            withIntl(<CourtListenerBlock
                label="Searched case law"
                items={[
                    {
                        caseName: "Donoghue v Stevenson",
                        citation: "[1932] AC 562",
                        url: "https://x.test",
                    },
                ]}
            />),
        );
        const search = screen.getByRole("button", {
            name: /Searched case law/,
        });
        // This one used to ship without any expansion state at all.
        expect(search).toHaveAttribute("aria-expanded", "false");
        expect(
            research.container.querySelector("svg.-rotate-90"),
        ).not.toBeNull();
    });
});
