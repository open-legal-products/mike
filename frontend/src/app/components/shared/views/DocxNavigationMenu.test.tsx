import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DocxNavigationMenu } from "./DocxNavigationMenu";

it("follows native overflow mounts, closes More on selection, and restores a menu at wide widths", async () => {
    const toolbar = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.dataset.slot = "toolbar.more";
    trigger.textContent = "More";
    toolbar.append(trigger);
    document.body.append(toolbar);
    const toggle = vi.fn();
    const { rerender, unmount } = render(<DocxNavigationMenu toolbar={toolbar} open={false} onToggle={toggle} />);
    try {
        expect(screen.getAllByRole("button", { name: "More" })).toHaveLength(1);
        expect(screen.queryByRole("button", { name: "Navigation pane" })).toBeNull();
        const panel = document.createElement("div");
        panel.className = "docx-toolbar__more-panel";
        await act(async () => { toolbar.append(panel); });
        const action = await screen.findByRole("button", { name: "Navigation pane" });
        expect(panel).toContainElement(action);
        expect(action).toHaveAttribute("aria-pressed", "false");
        const close = vi.fn(() => panel.remove());
        trigger.addEventListener("click", close);
        fireEvent.click(action);
        expect(toggle).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(trigger).toHaveFocus();
        await waitFor(() => expect(screen.queryByRole("button", { name: "Navigation pane" })).toBeNull());
        rerender(<DocxNavigationMenu toolbar={toolbar} open onToggle={toggle} />);
        await act(async () => { toolbar.append(panel); });
        expect(await screen.findByRole("button", { name: "Navigation pane" })).toHaveAttribute("aria-pressed", "true");
        await act(async () => { panel.remove(); trigger.remove(); });
        expect(await screen.findByRole("button", { name: "More" })).toHaveAttribute("aria-haspopup", "menu");
        // Resizing back restores EigenPal's menu without a duplicate trigger.
        await act(async () => { toolbar.append(trigger); });
        await waitFor(() => expect(screen.getAllByRole("button", { name: "More" })).toHaveLength(1));
    } finally {
        unmount();
        toolbar.remove();
    }
});
