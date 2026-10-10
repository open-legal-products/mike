import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppToasts, clearToasts, showToast } from "./toast";

describe("AppToasts", () => {
    beforeEach(() => {
        clearToasts();
        vi.useFakeTimers();
    });
    afterEach(() => {
        clearToasts();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("shows one offline notice while offline and a recovery notice after", () => {
        vi.stubGlobal("navigator", { ...navigator, onLine: true });
        render(<AppToasts />);
        expect(screen.queryByRole("alert")).toBeNull();

        act(() => {
            window.dispatchEvent(new Event("offline"));
            window.dispatchEvent(new Event("offline"));
        });
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(screen.getByRole("alert")).toHaveTextContent("You're offline");

        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByRole("alert")).toBeVisible();

        act(() => {
            window.dispatchEvent(new Event("online"));
        });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByRole("status")).toHaveTextContent(
            "You're back online.",
        );
    });

    it("keeps the offline notice through transient notifications until reconnecting", () => {
        vi.stubGlobal("navigator", { ...navigator, onLine: false });
        render(<AppToasts />);

        act(() => {
            for (let i = 0; i < 4; i += 1) {
                showToast({ tone: "success", message: `Saved ${i}` });
            }
        });
        expect(screen.getByRole("alert")).toHaveTextContent("You're offline");
        expect(screen.getAllByRole("status")).toHaveLength(2);
        expect(screen.queryByText("Saved 0")).toBeNull();

        act(() => {
            window.dispatchEvent(new Event("online"));
        });
        expect(screen.queryByRole("alert")).toBeNull();
        expect(screen.getByText("You're back online.")).toBeVisible();
    });

    it("draws an error as a WarningPopup in the notification column, with its actions", () => {
        vi.stubGlobal("navigator", { ...navigator, onLine: true });
        const onRetry = vi.fn();
        render(<AppToasts />);

        act(() => {
            showToast({
                tone: "error",
                title: "Couldn't get a response",
                message: "Select another model.",
                actions: [{ label: "Retry", onClick: onRetry }],
                supportHref: "mailto:support@example.com",
            });
            showToast({ tone: "success", message: "Changes saved" });
        });

        const region = screen.getByRole("region", { name: "Notifications" });
        const warning = screen.getByRole("alert");
        expect(region).toContainElement(warning);
        expect(region).toContainElement(screen.getByRole("status"));
        expect(warning).toHaveTextContent("Select another model.");
        expect(
            within(warning).getByRole("link", { name: "Contact support" }),
        ).toHaveAttribute("href", "mailto:support@example.com");
        // Contact support is a black pill, like every other notice action.
        expect(
            within(warning).getByRole("link", { name: "Contact support" }).className,
        ).toBe(within(warning).getByRole("button", { name: "Retry" }).className);

        // A warning stays until the user closes it.
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByRole("alert")).toBeVisible();
        expect(screen.queryByRole("status")).toBeNull();

        fireEvent.click(within(warning).getByRole("button", { name: "Retry" }));
        expect(onRetry).toHaveBeenCalledOnce();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("closes a warning from its dismiss button", () => {
        vi.stubGlobal("navigator", { ...navigator, onLine: true });
        render(<AppToasts />);
        act(() => {
            showToast({ tone: "error", message: "Upload failed." });
        });

        fireEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("raises the notice immediately when mounted offline", () => {
        vi.stubGlobal("navigator", { ...navigator, onLine: false });
        render(<AppToasts />);
        expect(screen.getByRole("alert")).toHaveTextContent("You're offline");
    });
});
