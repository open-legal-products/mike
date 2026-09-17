import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectWorkspaceTips } from "./ProjectWorkspaceTips";

describe("ProjectWorkspaceTips", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("loads a random tip and rotates in both directions", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.45);
        render(<ProjectWorkspaceTips />);

        await waitFor(() =>
            expect(
                screen.getByText(/Ask the Chat to edit a project document/),
            ).toBeVisible(),
        );
        expect(screen.getByText("Tip:").tagName).toBe("STRONG");
        expect(screen.getByText("3/5")).toBeVisible();

        fireEvent.click(screen.getByRole("button", { name: "Next tip" }));
        expect(
            screen.getByText(/The Chat can create a new project document/),
        ).toBeVisible();
        expect(screen.getByText("4/5")).toBeVisible();

        fireEvent.click(
            screen.getByRole("button", { name: "Previous tip" }),
        );
        expect(
            screen.getByText(/Ask the Chat to edit a project document/),
        ).toBeVisible();
    });
});
