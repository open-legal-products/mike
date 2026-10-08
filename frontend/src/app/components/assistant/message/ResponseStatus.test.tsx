import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResponseStatus, type StatusState } from "./ResponseStatus";

vi.mock("@/shared/ui/MikeIconUI", () => ({
    MikeIcon: ({
        spin,
        done,
        mike,
    }: {
        spin?: boolean;
        done?: boolean;
        mike?: boolean;
    }) => (
        <span
            data-testid="icon"
            data-spin={String(!!spin)}
            data-done={String(!!done)}
            data-mike={String(!!mike)}
        />
    ),
}));

const icon = () => screen.getByTestId("icon");

/** Long enough for the "done" animation frame to have fired if it was going to. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

function renderStatus(status: StatusState) {
    const view = render(<ResponseStatus status={status} />);
    return (next: StatusState) =>
        view.rerender(<ResponseStatus status={next} />);
}

describe("ResponseStatus", () => {
    it("shows done when a streaming response finishes", async () => {
        const set = renderStatus("active");
        expect(icon()).toHaveAttribute("data-spin", "true");

        set(null);

        await waitFor(() =>
            expect(icon()).toHaveAttribute("data-done", "true"),
        );
        expect(icon()).toHaveAttribute("data-spin", "false");
    });

    it("stops spinning without showing done while it waits on the user", async () => {
        const set = renderStatus("active");

        set("waiting");
        await settle();

        expect(icon()).toHaveAttribute("data-spin", "false");
        expect(icon()).toHaveAttribute("data-done", "false");
        expect(icon()).toHaveAttribute("data-mike", "true");
    });

    it("does not show done on the paused message once the user answers", async () => {
        const set = renderStatus("active");
        set("waiting");
        await settle();

        // Answering settles this message; the reply continues in the next.
        set(null);
        await settle();

        expect(icon()).toHaveAttribute("data-done", "false");
    });

    it("shows done when a paused response resumes and then finishes", async () => {
        const set = renderStatus("active");
        set("waiting");
        await settle();
        set("active");
        expect(icon()).toHaveAttribute("data-spin", "true");

        set(null);

        await waitFor(() =>
            expect(icon()).toHaveAttribute("data-done", "true"),
        );
    });
});
