import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CitationQuotesSection } from "./CitationQuotesSection";

describe("CitationQuotesSection", () => {
    it("uses verification from normalized document quotes", () => {
        render(
            <CitationQuotesSection
                document={{
                    document_id: "document-1",
                    title: "agreement.docx",
                    type: "docx",
                    metadata: [],
                    quotes: [
                        {
                            quote: "Unmatched model quote",
                            verification: { verified: false },
                            target: { page: 1 },
                        },
                    ],
                }}
            />,
        );

        expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
        expect(
            screen.getByText(/Unmatched model quote/).closest("button"),
        ).toBeNull();
        expect(screen.getByText("Could not verify quote")).toBeInTheDocument();
    });

    it("uses the View button to select a verified quote", () => {
        const onSelect = vi.fn();
        render(
            <CitationQuotesSection
                citationRef={3}
                document={{
                    document_id: "document-1",
                    title: "agreement.docx",
                    type: "docx",
                    metadata: [],
                    quotes: [
                        {
                            quote: "Matched source quote",
                            verification: { verified: true },
                            target: { page: 2 },
                        },
                    ],
                }}
                onSelect={onSelect}
            />,
        );

        const viewButton = screen.getByRole("button", { name: "View" });
        const citeButton = screen.getByRole("button", { name: "Cite" });
        expect(screen.getByLabelText("Citation 3")).toHaveClass(
            "self-start",
            "mt-0.5",
        );
        expect(screen.getByLabelText("Citation 3")).not.toHaveClass(
            "self-center",
        );
        expect(citeButton.parentElement).toBe(viewButton.parentElement);
        expect(citeButton.parentElement).toHaveClass("justify-between");
        expect(viewButton.closest(".liquid-glass-flat")).not.toBeNull();
        expect(screen.getByText(/Matched source quote/)).toHaveTextContent(
            "“Matched source quote” (Page 2)",
        );
        expect(screen.queryByText(/agreement\.docx/)).not.toBeInTheDocument();
        fireEvent.click(viewButton);
        expect(onSelect).toHaveBeenCalledWith(
            expect.objectContaining({ quote: "Matched source quote" }),
            0,
        );
    });

    it("does not add a label to case quotes", () => {
        render(
            <CitationQuotesSection
                document={{
                    document_id: "case:123",
                    title: "Example v Example, 123 U.S. 456",
                    type: "case",
                    metadata: [],
                    quotes: [
                        {
                            quote: "The court therefore concludes",
                            target: {
                                subdocument_id: "case:123:opinion:7",
                            },
                        },
                    ],
                    subdocuments: [
                        {
                            document_id: "case:123:opinion:7",
                            title: "Lead Opinion",
                            type: "html",
                            html: "<p>Opinion</p>",
                        },
                    ],
                }}
            />,
        );

        expect(
            screen.getByText(/The court therefore concludes/),
        ).toHaveTextContent("“The court therefore concludes”");
        expect(screen.queryByText(/Lead Opinion/)).not.toBeInTheDocument();
        expect(
            screen.queryByText(/Example v Example/),
        ).not.toBeInTheDocument();
    });
    const singleQuoteDocument = {
        document_id: "document-1",
        title: "agreement.docx",
        type: "docx" as const,
        metadata: [],
        quotes: [
            {
                quote: "Matched source quote",
                verification: { verified: true },
                target: { page: 2 },
            },
        ],
    };

    it("dismisses the section through the close control", () => {
        const onClose = vi.fn();
        render(
            <CitationQuotesSection
                document={singleQuoteDocument}
                onClose={onClose}
            />,
        );

        const close = screen.getByRole("button", { name: "Close" });
        expect(close.nextElementSibling).toBe(screen.getByRole("button", { name: "View" }));
        expect(close).toHaveClass("bg-transparent", "shadow-none");
        expect(close.querySelector("svg")).toBeNull();
        fireEvent.click(close);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("omits the close control when the section cannot be dismissed", () => {
        render(<CitationQuotesSection document={singleQuoteDocument} />);

        expect(
            screen.queryByRole("button", { name: "Close" }),
        ).not.toBeInTheDocument();
    });

    it("renders Cite as a white pill button", () => {
        render(<CitationQuotesSection document={singleQuoteDocument} />);

        expect(screen.getByRole("button", { name: "Cite" })).toHaveClass(
            "liquid-glass-flat",
            "rounded-full",
        );
    });
});
