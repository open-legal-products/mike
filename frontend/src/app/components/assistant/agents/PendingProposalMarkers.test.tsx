import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingProposalMarkers } from "./PendingProposalMarkers";

describe("PendingProposalMarkers", () => {
    it("renders nothing when no region has a pending proposal", () => {
        const { container } = render(
            <PendingProposalMarkers excerpts={[]} onOpen={vi.fn()} />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("marks each region that still has an unresolved proposal", () => {
        render(
            <PendingProposalMarkers
                excerpts={["the indemnity clause", "the arbitration clause"]}
                onOpen={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("list", { name: "Regions with proposed edits" }),
        ).toBeInTheDocument();
        expect(screen.getAllByRole("listitem")).toHaveLength(2);
    });

    it("opens the agent that owns the region", async () => {
        const user = userEvent.setup();
        const onOpen = vi.fn();
        render(
            <PendingProposalMarkers
                excerpts={["the indemnity clause"]}
                onOpen={onOpen}
            />,
        );

        await user.click(
            screen.getByRole("button", { name: "the indemnity clause" }),
        );
        expect(onOpen).toHaveBeenCalledWith("the indemnity clause");
    });
});
