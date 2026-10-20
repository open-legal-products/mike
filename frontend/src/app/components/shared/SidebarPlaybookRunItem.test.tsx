import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaybookRunHistoryItem } from "@/app/lib/mikeApi";
import { SidebarPlaybookRunItem } from "./SidebarPlaybookRunItem";

const run = {
    id: "run-1", playbookId: "pb-1", playbookName: "Vendor MSA playbook",
    documentName: "Master services agreement (final).docx", status: "completed",
    error: null, startedAt: "2026-10-18T00:00:00Z", completedAt: null,
} as PlaybookRunHistoryItem;

/** jsdom does no layout: give the title and its clipping box widths. */
function measure(titleWidth: number, boxWidth: number) {
    // The sliding title is the only styled element in the row.
    const title = screen.getByRole("link").querySelector<HTMLElement>("span[style]")!;
    Object.defineProperty(title, "offsetWidth", { configurable: true, value: titleWidth });
    Object.defineProperty(title.parentElement!, "clientWidth", { configurable: true, value: boxWidth });
    return title;
}

describe("SidebarPlaybookRunItem", () => {
    it("links to the run and slides a clipped title into view on hover, like a chat row", () => {
        const onOpen = vi.fn();
        render(<SidebarPlaybookRunItem run={run} isActive={false} onOpen={onOpen} />);
        const link = screen.getByRole("link", {
            name: "Playbook run: Vendor MSA playbook: Master services agreement (final).docx",
        });
        expect(link).toHaveAttribute("href", "/playbooks/pb-1?tab=runs&run=run-1");
        const title = measure(260, 160);

        fireEvent.mouseEnter(link);
        expect(title.style.transform).toBe("translateX(-100px)");
        fireEvent.mouseLeave(link);
        expect(title.style.transform).toBe("translateX(-0px)");
    });

    it("leaves a title that fits where it is", () => {
        render(<SidebarPlaybookRunItem run={run} isActive={false} onOpen={vi.fn()} />);
        const title = measure(120, 160);
        fireEvent.mouseEnter(screen.getByRole("link"));
        expect(title.style.transform).toBe("translateX(-0px)");
    });

    it("shows a spinner while running and a tick once finished", () => {
        const { rerender } = render(
            <SidebarPlaybookRunItem run={run} isActive={false} status="loading" onOpen={vi.fn()} />,
        );
        expect(screen.getByRole("status", {
            name: "Master services agreement (final).docx review running",
        })).toBeInTheDocument();
        rerender(<SidebarPlaybookRunItem run={run} isActive status="complete" onOpen={vi.fn()} />);
        expect(screen.queryByRole("status")).toBeNull();
        expect(screen.getByRole("link")).toHaveAttribute("aria-current", "page");
        expect(screen.getByRole("link")).toHaveAccessibleName(/\(Complete\)$/);
    });
});
