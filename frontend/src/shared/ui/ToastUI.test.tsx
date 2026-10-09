import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MAX_VISIBLE_TOASTS,
    focusToast,
    ToastViewportUI,
    clearToasts,
    dismissToast,
    showToast,
} from "./ToastUI";

describe("ToastUI", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        clearToasts();
    });
    afterEach(() => {
        clearToasts();
        vi.useRealTimers();
    });

    it("renders an error toast as an alert with title, message and dismiss", () => {
        render(<ToastViewportUI />);
        act(() => {
            showToast({
                tone: "error",
                title: "Couldn't save the document",
                message: "Mike couldn't reach the server.",
            });
        });
        const alert = screen.getByRole("alert");
        expect(alert).toHaveTextContent("Couldn't save the document");
        expect(alert).toHaveTextContent("Mike couldn't reach the server.");
        expect(alert).toHaveClass("liquid-glass-float");

        fireEvent.click(
            screen.getByRole("button", { name: "Dismiss notification" }),
        );
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("runs a Retry action and closes the toast", async () => {
        const onRetry = vi.fn();
        render(<ToastViewportUI />);
        act(() => {
            showToast({
                tone: "error",
                message: "Failed",
                actions: [{ label: "Retry", onClick: onRetry }],
            });
        });
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(onRetry).toHaveBeenCalledOnce();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("links Contact support to the given href", () => {
        render(<ToastViewportUI />);
        act(() => {
            showToast({
                tone: "error",
                message: "Failed",
                supportHref: "mailto:will@mikeoss.com?subject=x",
            });
        });
        const link = screen.getByRole("link", { name: "Contact support" });
        expect(link).toHaveAttribute("href", "mailto:will@mikeoss.com?subject=x");
    });

    it("keeps an error with actions until dismissed but auto-dismisses success", () => {
        render(<ToastViewportUI />);
        act(() => {
            showToast({
                tone: "error",
                message: "Sticky",
                actions: [{ label: "Retry", onClick: () => {} }],
            });
            showToast({ tone: "success", message: "Saved" });
        });
        expect(screen.getByRole("status")).toHaveTextContent("Saved");
        act(() => {
            vi.advanceTimersByTime(4_100);
        });
        expect(screen.queryByRole("status")).toBeNull();
        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByRole("alert")).toHaveTextContent("Sticky");
    });

    it("auto-dismisses a plain error toast after its duration", () => {
        render(<ToastViewportUI />);
        act(() => {
            showToast({ tone: "error", message: "Plain" });
        });
        expect(screen.getByRole("alert")).toBeVisible();
        act(() => {
            vi.advanceTimersByTime(10_100);
        });
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("pauses the timer while hovered", () => {
        render(<ToastViewportUI />);
        act(() => {
            showToast({ tone: "info", message: "Hover me" });
        });
        const toast = screen.getByRole("status");
        fireEvent.mouseEnter(toast);
        act(() => {
            vi.advanceTimersByTime(20_000);
        });
        expect(screen.getByRole("status")).toBeVisible();
        fireEvent.mouseLeave(toast);
        act(() => {
            vi.advanceTimersByTime(6_000);
        });
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("keeps a timed toast while keyboard focus remains after the pointer leaves", () => {
        render(<ToastViewportUI />);
        act(() => { showToast({ message: "Read this", durationMs: 2000 }); });
        const toast = screen.getByRole("status");
        const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
        fireEvent.mouseEnter(toast);
        fireEvent.focus(dismiss);
        fireEvent.mouseLeave(toast);
        act(() => { vi.advanceTimersByTime(10000); });
        expect(toast).toBeVisible();
        fireEvent.blur(dismiss, { relatedTarget: document.body });
        act(() => { vi.advanceTimersByTime(2100); });
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("replaces toasts that share a dedupe key", () => {
        render(<ToastViewportUI />);
        act(() => {
            showToast({ tone: "error", message: "First", dedupeKey: "poll" });
            showToast({ tone: "error", message: "Second", dedupeKey: "poll" });
        });
        const alerts = screen.getAllByRole("alert");
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toHaveTextContent("Second");
    });

    it("drops the oldest toast beyond the visible maximum", () => {
        render(<ToastViewportUI />);
        act(() => {
            for (let i = 0; i < MAX_VISIBLE_TOASTS + 2; i += 1) {
                showToast({ tone: "info", message: `Toast ${i}` });
            }
        });
        const items = screen.getAllByTestId("toast");
        expect(items).toHaveLength(MAX_VISIBLE_TOASTS);
        expect(items[0]).toHaveTextContent("Toast 2");
    });

    it("evicts chatter before an error the user still has to act on", () => {
        render(<ToastViewportUI />);
        act(() => {
            showToast({
                tone: "error",
                message: "Upload failed",
                actions: [{ label: "Retry", onClick: () => {} }],
            });
            for (let i = 0; i < MAX_VISIBLE_TOASTS; i += 1) {
                showToast({ tone: "success", message: `Saved ${i}` });
            }
        });
        const items = screen.getAllByTestId("toast");
        expect(items).toHaveLength(MAX_VISIBLE_TOASTS);
        expect(items[0]).toHaveTextContent("Upload failed");
        expect(
            screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
        // The oldest success was dropped in its place.
        expect(screen.queryByText("Saved 0")).toBeNull();
    });

    it("falls back to the oldest when every toast is actionable", () => {
        render(<ToastViewportUI />);
        act(() => {
            for (let i = 0; i < MAX_VISIBLE_TOASTS + 1; i += 1) {
                showToast({
                    tone: "error",
                    message: `Error ${i}`,
                    actions: [{ label: "Retry", onClick: () => {} }],
                });
            }
        });
        const items = screen.getAllByTestId("toast");
        expect(items).toHaveLength(MAX_VISIBLE_TOASTS);
        expect(items[0]).toHaveTextContent("Error 1");
    });

    it("dismissToast ignores unknown ids", () => {
        render(<ToastViewportUI />);
        let id = "";
        act(() => {
            id = showToast({ message: "x" });
            dismissToast("nope");
        });
        expect(screen.getByRole("status")).toBeVisible();
        act(() => {
            dismissToast(id);
        });
        expect(screen.queryByRole("status")).toBeNull();
    });

    it("labels the viewport as a region and leaves the live role to each toast", () => {
        render(<ToastViewportUI />);
        const region = screen.getByRole("region", { name: "Notifications" });
        // A live region wrapping live items is announced twice, or not at all.
        expect(region).not.toHaveAttribute("aria-live");
        act(() => {
            showToast({ tone: "error", message: "Failed" });
            showToast({ tone: "info", message: "FYI" });
        });
        expect(screen.getByRole("alert")).toHaveTextContent("Failed");
        expect(screen.getByRole("status")).toHaveTextContent("FYI");
    });

    it("does not steal focus, but focusToast can move it to a toast", () => {
        render(
            <>
                <button type="button">Elsewhere</button>
                <ToastViewportUI />
            </>,
        );
        const outside = screen.getByRole("button", { name: "Elsewhere" });
        outside.focus();
        let id = "";
        act(() => {
            id = showToast({
                tone: "error",
                message: "Failed",
                actions: [{ label: "Retry", onClick: () => {} }],
            });
        });
        expect(document.activeElement).toBe(outside);

        let moved = false;
        act(() => {
            moved = focusToast(id);
        });
        expect(moved).toBe(true);
        expect(document.activeElement).toBe(screen.getByRole("alert"));
        expect(screen.getByRole("alert")).toHaveAttribute("tabindex", "-1");

        act(() => {
            dismissToast(id);
        });
        expect(focusToast(id)).toBe(false);
    });
});
