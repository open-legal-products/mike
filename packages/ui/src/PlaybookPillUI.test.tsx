import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PlaybookPillUI } from "./PlaybookPillUI";

describe("PlaybookPillUI", () => {
    it("in a composer, opens and removes the playbook by name", async () => {
        const onOpen = vi.fn();
        const onRemove = vi.fn();
        render(
            <form>
                <PlaybookPillUI
                    title="NDA review"
                    onOpen={onOpen}
                    onRemove={onRemove}
                />
            </form>,
        );
        const open = screen.getByRole("button", {
            name: "Open playbook NDA review",
        });
        const remove = screen.getByRole("button", {
            name: "Remove playbook NDA review",
        });
        // Inside a form, neither may submit it.
        expect(open).toHaveAttribute("type", "button");
        expect(remove).toHaveAttribute("type", "button");
        await userEvent.click(open);
        await userEvent.click(remove);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it("on a sent message, is a plain label", () => {
        render(<PlaybookPillUI title="NDA review" />);
        expect(screen.getByText("NDA review")).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });
});
