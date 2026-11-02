import { createRef } from "react";
import { Download } from "lucide-react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TextButtonUI } from "./TextButtonUI";
import { textButtonUIClassName } from "./TextButtonUI.styles";

describe("TextButtonUI", () => {
    it("supports keyboard activation without submitting the surrounding form", async () => {
        const onClick = vi.fn();
        const onSubmit = vi.fn((event) => event.preventDefault());
        const ref = createRef<HTMLButtonElement>();
        const user = userEvent.setup();
        render(
            <form onSubmit={onSubmit}>
                <TextButtonUI ref={ref} onClick={onClick}>
                    Download
                </TextButtonUI>
            </form>,
        );
        await user.tab();
        expect(ref.current).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(onClick).toHaveBeenCalledOnce();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(ref.current).toHaveClass(
            "bg-transparent",
            "border-0",
            "shadow-none",
            "focus-visible:ring-2",
        );
    });

    it("retains its accessible name and prevents repeat activation while loading", () => {
        const onClick = vi.fn();
        const { rerender } = render(
            <TextButtonUI loading onClick={onClick}>
                <Download aria-hidden="true" />
                Download
            </TextButtonUI>,
        );
        const button = screen.getByRole("button", { name: "Download" });
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-busy", "true");
        fireEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
        rerender(<TextButtonUI onClick={onClick}>Download</TextButtonUI>);
        fireEvent.click(button);
        expect(onClick).toHaveBeenCalledOnce();
    });

    it("supports named icon-only actions and native disabled behavior", () => {
        const onClick = vi.fn();
        render(
            <TextButtonUI
                size="icon-xs"
                aria-label="Download document"
                disabled
                onClick={onClick}
            >
                <Download aria-hidden="true" />
            </TextButtonUI>,
        );
        const button = screen.getByRole("button", {
            name: "Download document",
        });
        expect(button).toHaveClass("w-6");
        fireEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
    });

    it("shares its appearance with links while preserving navigation semantics", () => {
        render(
            <a href="#source" className={textButtonUIClassName()}>
                Source
            </a>,
        );
        expect(screen.getByRole("link", { name: "Source" })).toHaveAttribute(
            "href",
            "#source",
        );
        expect(screen.getByRole("link")).toHaveClass(
            "bg-transparent",
            "focus-visible:ring-2",
        );
        expect(screen.queryByRole("button")).toBeNull();
    });
});
