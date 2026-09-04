import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Citation, DocumentCitation } from "../../shared/types";
import { citationTooltip, CitationsBlock } from "./CitationSources";

function documentCitation(ref: number, verified?: boolean): DocumentCitation {
  return {
    type: "citation_data",
    kind: "document",
    ref,
    doc_id: `doc-${ref}`,
    document_id: `document-${ref}`,
    filename: `source-${ref}.pdf`,
    page: ref,
    quote: `Quote ${ref}`,
    quotes: [{ page: ref, quote: `Quote ${ref}` }],
    ...(verified === undefined ? {} : { verified }),
  };
}

describe("CitationsBlock verification states", () => {
  it("marks unverified document citation buttons with the error colors", () => {
    render(
      <CitationsBlock
        citations={[documentCitation(1, false), documentCitation(2)]}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Citation 1. Could not verify quote",
      }),
    ).toHaveClass(
      "!bg-red-100/85",
      "!text-red-800",
      "dark:!bg-red-950",
      "dark:!text-white",
    );
    const verifiedButton = screen.getByRole("button", {
      name: "Citation 2",
    });
    expect(verifiedButton).toHaveClass("bg-gray-200/80", "text-gray-800");
  });

  it("includes only unverified warnings in citation tooltips", () => {
    expect(citationTooltip(documentCitation(3, false))).toContain(
      "Quote could not be matched to the source text.",
    );
    expect(citationTooltip(documentCitation(3, true))).not.toContain("matched");
  });

  it("leaves case citations outside document verification styling", () => {
    const citation: Citation = {
      type: "citation_data",
      kind: "case",
      ref: 4,
      cluster_id: 99,
      case_name: "Example v Example",
      quotes: [],
    };
    render(<CitationsBlock citations={[citation]} />);

    const button = screen.getByRole("button", { name: "Citation 4" });
    expect(button).toHaveClass("bg-gray-200/80", "text-gray-800");
  });

  it("adds the selected quote background only to the active citation", () => {
    const inactive = documentCitation(1);
    const active = documentCitation(2);

    render(
      <CitationsBlock
        citations={[inactive, active]}
        activeCitation={active}
      />,
    );

    expect(screen.getByRole("button", { name: "Citation 2" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Citation 2" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "Citation 1" }),
    ).not.toHaveAttribute("data-active");
  });

  it("uses normalized legislation titles and icons without a fake page", () => {
    const citation: DocumentCitation = {
      type: "citation_data",
      kind: "document",
      ref: 5,
      doc_id: "source-0",
      document_id: "legal-data-hunter:legislation:LEGIARTI000001",
      filename: "source-0",
      page: 1,
      quote: "Les contrats légalement formés tiennent lieu de loi.",
      quotes: [
        {
          page: 1,
          quote: "Les contrats légalement formés tiennent lieu de loi.",
        },
      ],
      document: {
        document_id: "legal-data-hunter:legislation:LEGIARTI000001",
        title: "Code civil, article 1103",
        type: "legislation",
        metadata: [{ label: "Citation", value: "Article 1103" }],
        quotes: [
          {
            quote: "Les contrats légalement formés tiennent lieu de loi.",
            target: {
              subdocument_id:
                "legal-data-hunter:legislation:LEGIARTI000001:text",
            },
          },
        ],
      },
    };

    const { container } = render(<CitationsBlock citations={[citation]} />);

    expect(screen.getByText("Code civil, article 1103")).toBeInTheDocument();
    expect(
      container.querySelector(
        'img[src*="/icons/legal-sources/legislation.svg"]',
      ),
    ).toBeInTheDocument();
    expect(citationTooltip(citation)).not.toContain("Page 1");
  });
});
