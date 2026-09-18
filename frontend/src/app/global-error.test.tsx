import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import GlobalError from "./global-error";

vi.mock("@/app/lib/errorReporting", () => ({ reportError: vi.fn() }));

/**
 * `global-error` REPLACES the root layout, so globals.css and Tailwind are
 * never loaded on this page: anything styled by a class from the design
 * system renders as bare browser chrome. Its controls must therefore be
 * plain elements styled by the inline <style> block, and they must still be
 * real, named controls.
 */
describe("GlobalError", () => {
    function renderError(reset?: () => void) {
        const error = Object.assign(new Error("boom"), { digest: "d1gest" });
        // The component renders <html>/<body>; React puts them in place of
        // jsdom's own when it is the container's only child.
        return render(<GlobalError error={error} reset={reset} />, {
            container: document.documentElement,
            baseElement: document.documentElement,
        });
    }

    it("renders its actions as named buttons, not design-system markup", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const reset = vi.fn();
        renderError(reset);

        const tryAgain = screen.getByRole("button", { name: "Try again" });
        const back = screen.getByRole("button", { name: "Back" });
        expect(tryAgain.tagName).toBe("BUTTON");
        expect(tryAgain.getAttribute("type")).toBe("button");
        expect(back.getAttribute("type")).toBe("button");
        // Styled by the inline block, which is the only CSS this page has.
        expect(tryAgain.className).toContain("error-btn");
        expect(back.className).toContain("error-btn");

        tryAgain.click();
        expect(reset).toHaveBeenCalledTimes(1);
    });

    it("offers support by email, the one channel a broken layout still has", () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        renderError();
        const support = screen.getByRole("link", { name: "Contact support" });
        expect(support.getAttribute("href")).toMatch(/^mailto:/);
        expect(screen.getByText(/d1gest/)).toBeTruthy();
    });
});
