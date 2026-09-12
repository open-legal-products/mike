import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Citation, DocumentCitation } from "../../shared/types";
import { withIntl } from "@/test/withIntl";
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
      withIntl(<CitationsBlock
        citations={[documentCitation(1, false), documentCitation(2)]}
      />),
    );

    expect(
      screen.getByRole("button", {
        name: "Citação 1. Não foi possível verificar a citação",
      }),
    ).toHaveClass(
      "!bg-red-100/85",
      "!text-red-800",
      "dark:!bg-red-950",
      "dark:!text-white",
    );
    const verifiedButton = screen.getByRole("button", {
      name: "Citação 2",
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
    render(withIntl(<CitationsBlock citations={[citation]} />));

    const button = screen.getByRole("button", { name: "Citação 4" });
    expect(button).toHaveClass("bg-gray-200/80", "text-gray-800");
  });

  it("adds the selected quote background only to the active citation", () => {
    const inactive = documentCitation(1);
    const active = documentCitation(2);

    render(
      withIntl(<CitationsBlock
        citations={[inactive, active]}
        activeCitation={active}
      />),
    );

    expect(screen.getByRole("button", { name: "Citação 2" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Citação 2" }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: "Citação 1" }),
    ).not.toHaveAttribute("data-active");
  });
});
