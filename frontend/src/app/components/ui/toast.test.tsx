import { act, render, screen } from "@testing-library/react";
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

    it("raises the notice immediately when mounted offline", () => {
        vi.stubGlobal("navigator", { ...navigator, onLine: false });
        render(<AppToasts />);
        expect(screen.getByRole("alert")).toHaveTextContent("You're offline");
    });
});
