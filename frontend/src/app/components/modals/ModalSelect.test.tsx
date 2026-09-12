import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { ModalSelect } from "./ModalSelect";

describe("ModalSelect", () => {
    it("portals its open menu above modal content and footers", () => {
        const { container } = render(
            withIntl(
                <div data-testid="modal-content" className="overflow-y-auto">
                    <ModalSelect
                        id="language"
                        value="English"
                        options={["English", "French"]}
                        onChange={vi.fn()}
                        open
                    />
                </div>,
            ),
        );

        const menu = screen.getByRole("menu");
        expect(menu).toHaveClass("z-[250]");
        expect(container).not.toContainElement(menu);
        expect(container.querySelector("button")).toHaveClass("text-sm");
        expect(screen.getByRole("menuitem", { name: "French" })).toHaveClass(
            "text-xs",
        );
    });

    it("finds an option from keyboard input", async () => {
        render(
            withIntl(
                <ModalSelect
                    id="country"
                    value="Australia"
                    options={["Australia", "Singapore", "United Kingdom"]}
                    onChange={vi.fn()}
                    open
                />,
            ),
        );

        const menu = screen.getByRole("menu");
        menu.focus();
        fireEvent.keyDown(menu, { key: "s" });

        await waitFor(() =>
            expect(
                screen.getByRole("menuitem", { name: "Singapore" }),
            ).toHaveFocus(),
        );
    });
});
