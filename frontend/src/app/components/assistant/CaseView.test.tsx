import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CaseView } from "./CaseView";

const document = {
    document_id: "case:test",
    title: "Example v Example, 123 U.S. 456",
    type: "case" as const,
    metadata: [],
    quotes: [],
    subdocuments: [
        {
            document_id: "case:test:opinion:1",
            title: "Lead Opinion by Judge One",
            type: "html" as const,
            html: '<p>Lead content</p><script>alert("unsafe")</script>',
        },
        {
            document_id: "case:test:opinion:2",
            title: "Dissent by Judge Two",
            type: "html" as const,
            html: "<p>Dissent content</p>",
        },
    ],
};

describe("CaseView", () => {
    beforeEach(() => {
        Element.prototype.scrollIntoView = vi.fn();
    });

    it("renders already-hydrated subdocuments and sanitizes their HTML", () => {
        const { container } = render(<CaseView document={document} />);

        expect(screen.getByText("Lead content")).toBeInTheDocument();
        expect(container.querySelector("script")).not.toBeInTheDocument();
    });

    it("switches between normalized case subdocuments", () => {
        render(<CaseView document={document} />);

        fireEvent.click(
            screen.getByRole("button", { name: "Dissent by Judge Two" }),
        );
        expect(screen.getAllByText("Dissent content")).not.toHaveLength(0);
        expect(screen.queryByText("Lead content")).not.toBeInTheDocument();
    });

    it("offers a retry when hydration fails", () => {
        const onRetry = vi.fn();
        render(
            <CaseView
                document={{
                    document_id: "case:failed",
                    title: "Failed case",
                    type: "case",
                    metadata: [],
                    quotes: [],
                }}
                error="Could not load this document."
                onRetry={onRetry}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it("moves to and highlights the active quote's subdocument", () => {
        const quote = {
            quote: "Dissent content",
            verification: { verified: true },
            target: {
                subdocument_id: "case:test:opinion:2",
            },
        };
        const { container, rerender } = render(
            <CaseView
                document={{ ...document, quotes: [quote] }}
                activeQuote={quote}
            />,
        );

        expect(screen.getAllByText("Dissent content")).not.toHaveLength(0);
        expect(screen.queryByText("Lead content")).not.toBeInTheDocument();
        expect(
            container.querySelector(".case-quote-highlight"),
        ).toHaveTextContent("Dissent content");
        rerender(<CaseView document={{ ...document, quotes: [quote] }} />);
        expect(container.querySelector(".case-quote-highlight")).toBeNull();
        expect(screen.getByText("Dissent content")).toBeVisible();
    });

    it("marks the full case quote across nested HTML nodes", () => {
        const quote = {
            quote: "The Court therefore concludes that relief is denied",
            verification: { verified: true },
            target: { subdocument_id: "case:test:opinion:1" },
        };
        const { container } = render(
            <CaseView
                document={{
                    ...document,
                    quotes: [quote],
                    subdocuments: [
                        {
                            ...document.subdocuments[0],
                            html: "<p>The Court <strong>therefore concludes</strong> that relief is denied.</p>",
                        },
                    ],
                }}
                activeQuote={quote}
            />,
        );

        const highlights = Array.from(
            container.querySelectorAll(".case-quote-highlight"),
        );
        expect(highlights.length).toBeGreaterThan(1);
        const highlightedText = highlights
            .map((element) => element.textContent)
            .join("")
            .replace(/[^a-zA-Z0-9]/g, "")
            .toLowerCase();
        expect(highlightedText).toBe(
            "thecourtthereforeconcludesthatreliefisdenied",
        );
    });
});
