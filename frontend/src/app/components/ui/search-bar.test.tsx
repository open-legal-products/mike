import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "./search-bar";

describe("SearchBar", () => {
    it("gives the input a default accessible name", () => {
        render(<SearchBar value="" onValueChange={() => {}} />);
        expect(
            screen.getByRole("searchbox", { name: "Search" }),
        ).toBeInTheDocument();
    });

    it("lets callers override the accessible name", () => {
        render(
            <SearchBar
                value=""
                onValueChange={() => {}}
                aria-label="Search workflows"
            />,
        );
        expect(
            screen.getByRole("searchbox", { name: "Search workflows" }),
        ).toBeInTheDocument();
    });

    it("shows a focus ring on the wrapper because the input suppresses its outline", () => {
        const { container } = render(
            <SearchBar value="" onValueChange={() => {}} />,
        );
        expect(
            container.querySelector('[data-slot="search-bar"]'),
        ).toHaveClass("focus-within:ring-2");
    });

    it("clears the value from the labelled clear button", async () => {
        const onValueChange = vi.fn();
        const user = userEvent.setup();
        render(<SearchBar value="draft" onValueChange={onValueChange} />);

        await user.click(screen.getByRole("button", { name: "Clear search" }));

        expect(onValueChange).toHaveBeenCalledWith("");
    });

    it("gives the clear button a visible focus ring", () => {
        render(<SearchBar value="draft" onValueChange={() => {}} />);
        expect(
            screen.getByRole("button", { name: "Clear search" }),
        ).toHaveClass("focus-visible:ring-2");
    });

    it("cannot be clicked into or typed in while disabled", async () => {
        const onValueChange = vi.fn();
        const user = userEvent.setup();
        const { container } = render(
            <SearchBar value="" onValueChange={onValueChange} disabled />,
        );
        const input = screen.getByRole("searchbox");

        await user.click(input);
        await user.keyboard("abc");

        expect(input).toBeDisabled();
        expect(input).not.toHaveFocus();
        expect(onValueChange).not.toHaveBeenCalled();
        expect(input).toHaveClass("disabled:cursor-not-allowed");
        expect(
            container.querySelector('[data-slot="search-bar"]'),
        ).toHaveClass("cursor-not-allowed");
        // The same glass as every other input; only the cursor says it is shut.
        expect(
            container.querySelector('[data-slot="search-bar"]'),
        ).not.toHaveClass("opacity-60");
    });

    it("gives up focus when it shuts while focused", () => {
        const { rerender } = render(
            <SearchBar value="" onValueChange={() => {}} />,
        );
        const input = screen.getByRole("searchbox");
        input.focus();
        expect(input).toHaveFocus();

        rerender(<SearchBar value="" onValueChange={() => {}} disabled />);

        expect(input).not.toHaveFocus();
    });

    it("still hands its input to a forwarded ref", () => {
        const ref = { current: null as HTMLInputElement | null };
        render(<SearchBar ref={ref} value="" onValueChange={() => {}} />);
        expect(ref.current).toBe(screen.getByRole("searchbox"));
    });

    it("offers no clear button while disabled", () => {
        render(<SearchBar value="draft" onValueChange={() => {}} disabled />);
        expect(
            screen.queryByRole("button", { name: "Clear search" }),
        ).toBeNull();
    });
});
