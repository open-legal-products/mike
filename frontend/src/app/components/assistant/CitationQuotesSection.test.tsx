import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { CitationQuotesSection } from "./CitationQuotesSection";

describe("CitationQuotesSection", () => {
    it("uses verification from normalized document quotes", () => {
        render(
            withIntl(<CitationQuotesSection
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
            />),
        );

        expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
        expect(
            screen.getByText(/Unmatched model quote/).closest("button"),
        ).toBeNull();
        expect(screen.getByText("Não foi possível verificar a citação")).toBeInTheDocument();
    });

    it("uses the View button to select a verified quote", () => {
        const onSelect = vi.fn();
        render(
            withIntl(
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
                // O componente renderiza o badge com `tCitacoes("citacao")`
                // sem interpolar `{ref}`; sobrescrevemos a mensagem no teste
                // para o rótulo ficar estático.
                {
                    assistant: {
                        citacoes: { citacao: "Citação" },
                    },
                },
            ),
        );

        const viewButton = screen.getByRole("button", { name: "View" });
        const citeButton = screen.getByRole("button", { name: "Cite" });
        expect(screen.getByLabelText("Citação 3")).toHaveClass(
            "self-start",
            "mt-0.5",
        );
        expect(screen.getByLabelText("Citação 3")).not.toHaveClass(
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
            withIntl(<CitationQuotesSection
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
            />),
        );

        expect(
            screen.getByText(/The court therefore concludes/),
        ).toHaveTextContent("“The court therefore concludes”");
        expect(screen.queryByText(/Lead Opinion/)).not.toBeInTheDocument();
        expect(
            screen.queryByText(/Example v Example/),
        ).not.toBeInTheDocument();
    });
});
