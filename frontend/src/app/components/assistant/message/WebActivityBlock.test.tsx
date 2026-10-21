import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WebReadBlock, WebSearchBlock } from "./WebActivityBlock";

const search = {
    type: "web_search" as const,
    search_id: "ws-1",
    query: "directors duties",
    results: [
        { url: "https://www.legislation.gov.uk/ukpga/2006/46/section/172", title: "Companies Act 2006, s 172" },
        { url: "javascript:alert(1)", title: "Trap" },
    ],
};

describe("web activity blocks", () => {
    it("lists web page results as links that open in a new tab", () => {
        render(<WebSearchBlock event={search} />);

        fireEvent.click(screen.getByRole("button", { name: "Searched the web for “directors duties”" }));

        const links = screen.getAllByRole("link");
        expect(links).toHaveLength(1);
        expect(links[0]).toHaveAccessibleName(/Companies Act 2006, s 172/);
        expect(links[0]).toHaveAttribute("href", search.results[0].url);
        expect(links[0]).toHaveAttribute("target", "_blank");
        expect(screen.getByText("Trap")).toBeInTheDocument();
    });

    it("shows the server's message for a failed search", () => {
        render(
            <WebSearchBlock
                event={{
                    ...search,
                    results: [],
                    error: "Web search is unavailable: the chosen search service has no API key set up.",
                    error_code: "not_configured",
                }}
            />,
        );

        expect(screen.getByText("Web search failed for “directors duties”")).toBeInTheDocument();
        expect(screen.getByText(/has no API key set up/)).toBeInTheDocument();
    });

    it("shows why a page could not be read, without linking it", () => {
        render(
            <WebReadBlock
                event={{
                    type: "web_read",
                    read_id: "wr-1",
                    url: "https://attacker.example/?q=secret",
                    error: "This page could not be read.",
                    error_code: "unreadable",
                }}
            />,
        );

        expect(screen.getByText("This page could not be read.")).toBeInTheDocument();
        expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });
});
