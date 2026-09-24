import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundaryPage from "./error";

describe("app error boundary", () => {
    beforeEach(() => {
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("re-renders the route when the user asks to try again", async () => {
        const reset = vi.fn();
        const user = userEvent.setup();
        render(
            <ErrorBoundaryPage
                error={Object.assign(new Error("boom"), { digest: "abc123" })}
                reset={reset}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Try again" }));

        expect(reset).toHaveBeenCalledTimes(1);
    });

    it("offers support with the error reference and never the raw message", () => {
        render(
            <ErrorBoundaryPage
                error={Object.assign(
                    new Error("TypeError: undefined is not a function"),
                    { digest: "abc123" },
                )}
                reset={vi.fn()}
            />,
        );

        const support = screen.getByRole("link", { name: "Contact support" });
        const href = decodeURIComponent(
            support.getAttribute("href") ?? "",
        ).replace(/%20/g, " ");
        expect(href).toContain("mailto:will@mikeoss.com");
        expect(href).toContain("Error reference: abc123");
        expect(
            screen.queryByText(/undefined is not a function/),
        ).not.toBeInTheDocument();
        expect(screen.getByText(/Error reference: abc123/)).toBeInTheDocument();
    });

    it("still renders without a reset handler", () => {
        render(<ErrorBoundaryPage error={new Error("boom")} />);

        expect(
            screen.queryByRole("button", { name: "Try again" }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    });
});
