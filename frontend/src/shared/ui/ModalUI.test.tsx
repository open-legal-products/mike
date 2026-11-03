import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModalUI } from "./ModalUI";

describe("ModalUI", () => {
    it("renders shared modal chrome, content, and action slots", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();

        render(
            <ModalUI
                open
                onClose={onClose}
                breadcrumbs={["Documents", "Add documents"]}
                ariaLabel="Add documents"
                primaryAction={<button type="button">Confirm</button>}
            >
                <p>Select documents</p>
            </ModalUI>,
        );

        expect(
            screen.getByRole("dialog", { name: "Add documents" }),
        ).toHaveClass("liquid-glass-modal");
        expect(screen.getByText("Select documents")).toBeVisible();
        expect(screen.getByRole("button", { name: "Confirm" })).toBeVisible();

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("closes on Escape", () => {
        const onClose = vi.fn();

        render(
            <ModalUI open onClose={onClose} ariaLabel="Example">
                Content
            </ModalUI>,
        );

        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("leaves Escape to a control inside the dialog that handled it", () => {
        const onClose = vi.fn();

        render(
            <ModalUI open onClose={onClose} ariaLabel="Example">
                <input
                    aria-label="Search"
                    onKeyDown={(event) => {
                        if (event.key === "Escape") event.preventDefault();
                    }}
                />
            </ModalUI>,
        );

        fireEvent.keyDown(screen.getByRole("textbox", { name: "Search" }), {
            key: "Escape",
        });
        expect(onClose).not.toHaveBeenCalled();
    });
    it("natively disables only the opt-in header close and restores ordinary close", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        const view = render(<ModalUI open onClose={onClose} breadcrumbs={["Example"]} closeButtonDisabled>Content</ModalUI>);
        expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
        await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).not.toHaveBeenCalled();
        // The prop concerns the header button; callers retain Escape/backdrop policy.
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
        view.rerender(<ModalUI open onClose={onClose} breadcrumbs={["Example"]}>Content</ModalUI>);
        expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

});
