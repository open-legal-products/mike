import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WarningPopup } from "./WarningPopup";

describe("WarningPopup", () => {
    it("announces warnings and closes on Escape", () => {
        const onClose = vi.fn();
        render(
            <WarningPopup
                open
                title="Save failed"
                message="Please try again."
                onClose={onClose}
            />,
        );

        const alert = screen.getByRole("alert");
        expect(alert).toHaveAttribute("aria-live", "assertive");
        expect(alert).toHaveAttribute("aria-atomic", "true");

        fireEvent.keyDown(document, { key: "Escape" });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
