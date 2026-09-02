import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
    QuotedExcerptChip,
    QuotedExcerptChips,
} from "./QuotedExcerptChip";

describe("QuotedExcerptChip", () => {
    it("shows the excerpt with the full text available on hover", () => {
        render(
            <QuotedExcerptChip
                excerpt="a very long excerpt"
                index={1}
                onRemove={() => {}}
            />,
        );
        const quote = screen.getByText("a very long excerpt");
        expect(quote).toHaveAttribute("title", "a very long excerpt");
        // Clamped so a long quote cannot push the composer off screen.
        expect(quote).toHaveClass("line-clamp-2");
        expect(screen.getByText("Quoted from response")).toBeInTheDocument();
    });

    it("gives the remove button an accessible name and a button type", () => {
        render(
            <QuotedExcerptChip excerpt="q" index={3} onRemove={() => {}} />,
        );
        const button = screen.getByRole("button", {
            name: "Remove quoted excerpt 3",
        });
        expect(button).toHaveAttribute("type", "button");
        expect(button.className).toContain("focus-visible:ring-2");
    });

    it("calls onRemove when the remove button is clicked", async () => {
        const onRemove = vi.fn();
        render(<QuotedExcerptChip excerpt="q" index={1} onRemove={onRemove} />);
        await userEvent.click(
            screen.getByRole("button", { name: "Remove quoted excerpt 1" }),
        );
        expect(onRemove).toHaveBeenCalledTimes(1);
    });
});

describe("QuotedExcerptChips", () => {
    it("renders nothing when there is nothing to show", () => {
        const { container } = render(
            <QuotedExcerptChips excerpts={[]} onRemove={() => {}} />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("stacks every attached excerpt", () => {
        render(
            <QuotedExcerptChips
                excerpts={["first", "second", "third"]}
                onRemove={() => {}}
            />,
        );
        expect(screen.getAllByRole("listitem")).toHaveLength(3);
        expect(screen.getByText("second")).toBeInTheDocument();
    });

    it("reports the index of the removed chip", async () => {
        const onRemove = vi.fn();
        render(
            <QuotedExcerptChips
                excerpts={["first", "second"]}
                onRemove={onRemove}
            />,
        );
        await userEvent.click(
            screen.getByRole("button", { name: "Remove quoted excerpt 2" }),
        );
        expect(onRemove).toHaveBeenCalledWith(1);
    });

    it("surfaces a truncation notice as a live status", () => {
        render(
            <QuotedExcerptChips
                excerpts={["first"]}
                onRemove={() => {}}
                notice="Excerpt shortened to 4,000 characters."
            />,
        );
        expect(screen.getByRole("status")).toHaveTextContent(
            "Excerpt shortened to 4,000 characters.",
        );
    });

    it("shows a notice even with no chips left", () => {
        render(
            <QuotedExcerptChips
                excerpts={[]}
                onRemove={() => {}}
                notice="heads up"
            />,
        );
        expect(screen.getByRole("status")).toHaveTextContent("heads up");
        expect(screen.queryByRole("list")).toBeNull();
    });
});
