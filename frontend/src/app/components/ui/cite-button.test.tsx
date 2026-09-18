import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { CiteButton } from "./cite-button";

describe("CiteButton", () => {
    beforeEach(() => {
        clearToasts();
    });

    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("renders the default 'Cite' label", () => {
        render(<CiteButton quoteText="hello" quoteLabel="Page 2" />);
        expect(
            screen.getByRole("button", { name: /cite/i }),
        ).toBeInTheDocument();
    });

    it("hides the label when showText is false", () => {
        render(
            <CiteButton
                quoteText="hello"
                quoteLabel="Page 2"
                showText={false}
            />,
        );
        expect(screen.queryByText("Cite")).not.toBeInTheDocument();
    });

    it("defaults to type=button so it never submits a form", () => {
        render(<CiteButton quoteText="hello" quoteLabel="Page 2" />);
        expect(screen.getByRole("button")).toHaveAttribute("type", "button");
    });

    it("names the icon-only button for assistive tech", () => {
        render(
            <CiteButton
                quoteText="hello"
                quoteLabel="Page 2"
                showText={false}
            />,
        );
        expect(
            screen.getByRole("button", { name: "Copy quote and citation" }),
        ).toBeInTheDocument();
    });

    it("leaves the visible label as the accessible name when text is shown", () => {
        render(<CiteButton quoteText="hello" quoteLabel="Page 2" />);
        // WCAG 2.5.3: the accessible name must contain the visible label.
        expect(screen.getByRole("button")).not.toHaveAttribute("aria-label");
    });

    it("has a visible keyboard focus ring", () => {
        render(<CiteButton quoteText="hello" quoteLabel="Page 2" />);
        expect(screen.getByRole("button")).toHaveClass("focus-visible:ring-2");
    });

    it("announces the copied state politely", async () => {
        const user = userEvent.setup();
        vi.spyOn(navigator.clipboard, "writeText");
        render(<CiteButton quoteText="hello" quoteLabel="Page 2" />);

        await user.click(screen.getByRole("button"));

        const status = await screen.findByRole("status");
        expect(status).toHaveTextContent("Copied");
    });

    it("copies the quote and citation, then shows 'Copied'", async () => {
        // userEvent.setup() installs a clipboard stub on navigator; spy on it.
        const user = userEvent.setup();
        const writeText = vi.spyOn(navigator.clipboard, "writeText");
        render(<CiteButton quoteText={`he said "hi"`} quoteLabel="Page 2" />);

        await user.click(screen.getByRole("button"));

        expect(writeText).toHaveBeenCalledWith(`"he said 'hi'" (Page 2)`);
        expect(await screen.findByText("Copied")).toBeInTheDocument();
    });

    it("tells the user when the clipboard refuses the copy", async () => {
        const user = userEvent.setup();
        vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
            new DOMException("Write permission denied.", "NotAllowedError"),
        );
        render(
            <>
                <CiteButton quoteText="hello" quoteLabel="Page 2" />
                <ToastViewportUI />
            </>,
        );

        await user.click(screen.getByRole("button", { name: /cite/i }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't copy this citation");
        expect(alert).toHaveTextContent("clipboard permission");
        expect(alert).not.toHaveTextContent("Write permission denied.");
        expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    });
});
