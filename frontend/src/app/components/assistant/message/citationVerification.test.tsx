import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Citation, DocumentCitation } from "../../shared/types";
import { withIntl } from "@/test/withIntl";
import { CitationQuotesSection } from "../CitationQuotesSection";
import {
  citationVerificationAriaLabel,
  citationVerificationPillClassName,
  citationVerificationState,
  CitationVerificationBadge,
} from "./citationVerification";

function documentCitation(verified?: boolean): DocumentCitation {
  return {
    type: "citation_data",
    kind: "document",
    ref: 1,
    doc_id: "doc-0",
    document_id: "document-1",
    filename: "agreement.pdf",
    page: 2,
    quote: "Exact source text",
    quotes: [{ page: 2, quote: "Exact source text" }],
    ...(verified === undefined ? {} : { verified }),
  };
}

const caseCitation: Citation = {
  type: "citation_data",
  kind: "case",
  ref: 2,
  cluster_id: 123,
  case_name: "Example v Example",
  quotes: [],
};

describe("citation verification presentation", () => {
  it("leaves verified document citations in their original gray style", () => {
    const citation = documentCitation(true);
    expect(citationVerificationState(citation)).toBe("verified");
    expect(citationVerificationAriaLabel(citation)).toBe("Citation 1");
    expect(citationVerificationPillClassName(citation)).toBe("");
  });

  it("uses the red error style for unverified citations", () => {
    const citation = documentCitation(false);
    expect(citationVerificationState(citation)).toBe("unverified");
    expect(citationVerificationAriaLabel(citation)).toBe(
      "Citation 1. Could not verify quote",
    );
    expect(citationVerificationPillClassName(citation)).toContain(
      "!bg-red-100/85",
    );
    expect(citationVerificationPillClassName(citation)).toContain(
      "!text-red-800",
    );
    expect(citationVerificationPillClassName(citation)).toContain(
      "dark:!bg-red-950",
    );
    expect(citationVerificationPillClassName(citation)).toContain(
      "dark:!text-white",
    );
  });

  it("leaves citations neutral while verification is not yet available", () => {
    const citation = documentCitation();
    expect(citationVerificationState(citation)).toBe("verified");
    expect(citationVerificationAriaLabel(citation)).toBe("Citation 1");
    expect(citationVerificationPillClassName(citation)).toBe("");
  });

  it("applies source verification semantics to case citations", () => {
    expect(citationVerificationState(caseCitation)).toBe("verified");
    expect(citationVerificationAriaLabel(caseCitation)).toBe("Citation 2");
    expect(citationVerificationPillClassName(caseCitation)).toBe("");

    const unverifiedCase = { ...caseCitation, verified: false };
    expect(citationVerificationState(unverifiedCase)).toBe("unverified");
    expect(citationVerificationAriaLabel(unverifiedCase)).toBe(
      "Citation 2. Could not verify quote",
    );
  });

  it("reveals an explanation from the white warning pill", async () => {
    const user = userEvent.setup();
    render(withIntl(<CitationVerificationBadge state="unverified" />));
    const trigger = screen.getByRole("button", {
      name: "Não foi possível verificar a citação",
    });
    expect(trigger).toHaveClass("liquid-glass-flat", "!text-red-600");
    expect(trigger).not.toHaveClass("bg-red-600/90");
    expect(
      screen.queryByText("Citação não encontrada no documento"),
    ).not.toBeInTheDocument();

    await user.click(trigger);

    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText("Citação não encontrada no documento")).toBeVisible();
    expect(
      screen.getByText(/Trate-a como alucinação/),
    ).toHaveTextContent(
      "confira no documento a seção correspondente da resposta do assistente",
    );
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("does not render a badge for verified quotes", () => {
    const { container } = render(
      withIntl(<CitationVerificationBadge state="verified" />),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows per-quote verification in the citation panel", () => {
    render(
      withIntl(<CitationQuotesSection
        citationRef={7}
        quotes={[
          {
            id: "quote-1",
            quote: "Model supplied quote",
            verificationState: "unverified",
          },
        ]}
        activeQuoteId="quote-1"
      />, {
        // O componente renderiza o badge com `tCitacoes("citacao")` sem
        // interpolar `{ref}`; sobrescrevemos a mensagem no teste.
        assistant: { citacoes: { citacao: "Citação" } },
      }),
    );

    expect(screen.getByLabelText("Citação 7")).toHaveTextContent("7");
    expect(screen.queryByText("Citação")).not.toBeInTheDocument();
    expect(screen.getByText("Não foi possível verificar a citação")).toBeVisible();
    expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
    expect(screen.getByText(/Model supplied quote/)).not.toHaveClass(
      "citation-quote-selected",
    );
  });

  it("formats normalized document quotes inside the quote section", () => {
    render(
      withIntl(<CitationQuotesSection
        document={{
          document_id: "spreadsheet-1",
          title: "Damages.xlsx",
          type: "spreadsheet",
          metadata: [],
          quotes: [
            {
              quote: "1,250,000",
              target: { sheet: "Summary", cell: "B7" },
              verification: { verified: true },
            },
          ],
        }}
        activeQuoteId="spreadsheet-1:quote:0"
        citationRef={4}
      />, {
        // O componente renderiza o badge com `tCitacoes("citacao")` sem
        // interpolar `{ref}`; sobrescrevemos a mensagem no teste.
        assistant: { citacoes: { citacao: "Citação" } },
      }),
    );

    expect(screen.getByText(/1,250,000/)).toHaveTextContent(
      "“1,250,000” (Summary, cell B7)",
    );
    expect(screen.getByLabelText("Citação 4")).toHaveTextContent("4");
  });
});
