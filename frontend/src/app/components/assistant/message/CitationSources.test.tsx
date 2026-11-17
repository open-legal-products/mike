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

  it.each([
    ["legislation", "/icons/legal-sources/legislation.svg"],
    ["case", "/icons/legal-sources/case-law.svg"],
  ] as const)(
    "shows the %s icon for an embedded legal source titled without an extension",
    (type, icon) => {
      const citation: DocumentCitation = {
        ...documentCitation(5),
        document_id: "mcp:legaldatahunter:legifrance:JORFTEXT0001",
        filename: "Article 1103",
        document: {
          document_id: "mcp:legaldatahunter:legifrance:JORFTEXT0001",
          title: "Article 1103",
          type,
          metadata: [],
          quotes: [],
        },
      };
      const { container } = render(<CitationsBlock citations={[citation]} />);

      expect(container.querySelector(`img[src*="${icon}"]`)).not.toBeNull();
    },
  );

  it("keeps the file-type icon for uploaded documents", () => {
    const { container } = render(
      <CitationsBlock citations={[documentCitation(6)]} />,
    );

    expect(
      container.querySelector('img[src*="/icons/file-types/pdf.svg"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('img[src*="/icons/legal-sources/"]'),
    ).toBeNull();
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
});
