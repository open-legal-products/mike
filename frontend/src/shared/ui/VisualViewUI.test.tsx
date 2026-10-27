import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualViewUI } from "./VisualViewUI";

const uuid = "4f1b7e8a-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const html = "<html><body><p>Rent by year</p></body></html>";

function frame() {
    return screen.getByTitle("Rent chart") as HTMLIFrameElement;
}

function post(source: Window | null, data: unknown) {
    act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, source }));
    });
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("VisualViewUI", () => {
    it("sandboxes the frame with allow-scripts only and no allow attribute", () => {
        render(<VisualViewUI html={html} title="Rent chart" theme="light" />);

        const iframe = frame();
        expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
        expect(iframe.hasAttribute("allow")).toBe(false);
        expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(iframe.getAttribute("srcdoc")).toContain("frame-src 'none'");
        expect(iframe.getAttribute("srcdoc")).toContain("<p>Rent by year</p>");
    });

    it("ignores messages from another source and malformed ones", () => {
        const onCite = vi.fn();
        render(<VisualViewUI html={html} title="Rent chart" theme="light" onCite={onCite} />);

        post(window, { type: "mike:cite", cite: uuid });
        post(null, { type: "mike:ready" });
        post(frame().contentWindow, { type: "mike:cite", cite: "not a document" });
        post(frame().contentWindow, "mike:cite");

        expect(onCite).not.toHaveBeenCalled();
        expect(screen.getByRole("status")).toHaveTextContent("Loading visual");
    });

    it("forwards a cite only while active and at most once every 400 ms", () => {
        const onCite = vi.fn();
        const { rerender } = render(
            <VisualViewUI html={html} title="Rent chart" theme="light" onCite={onCite} active={false} />,
        );
        const source = frame().contentWindow;

        post(source, { type: "mike:cite", cite: uuid, quote: "the quoted clause" });
        expect(onCite).not.toHaveBeenCalled();

        rerender(<VisualViewUI html={html} title="Rent chart" theme="light" onCite={onCite} active />);
        post(source, { type: "mike:cite", cite: uuid, quote: "the quoted clause" });
        post(source, { type: "mike:cite", cite: uuid, quote: "again" });
        expect(onCite).toHaveBeenCalledTimes(1);
        expect(onCite).toHaveBeenCalledWith({ cite: uuid, quote: "the quoted clause" });

        act(() => vi.advanceTimersByTime(400));
        post(source, { type: "mike:cite", cite: uuid, quote: "again" });
        expect(onCite).toHaveBeenCalledTimes(2);
    });

    it("re-posts the host message on a theme change without changing the srcdoc", () => {
        const { rerender } = render(
            <VisualViewUI html={html} title="Rent chart" theme="light" onCite={vi.fn()} />,
        );
        const iframe = frame();
        const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
        const srcDoc = iframe.getAttribute("srcdoc");

        post(iframe.contentWindow, { type: "mike:ready" });
        expect(postMessage).toHaveBeenLastCalledWith({ type: "mike:host", theme: "light", cites: true }, "*");

        rerender(<VisualViewUI html={html} title="Rent chart" theme="dark" />);
        expect(postMessage).toHaveBeenLastCalledWith({ type: "mike:host", theme: "dark", cites: false }, "*");
        expect(frame()).toBe(iframe);
        expect(iframe.getAttribute("srcdoc")).toBe(srcDoc);
    });

    it("shows the skeleton until the visual is ready, or for 1.5 s after the frame loads", () => {
        const { unmount } = render(<VisualViewUI html={html} title="Rent chart" theme="light" />);
        expect(screen.getByRole("status")).toHaveTextContent("Loading visual");
        expect(frame()).toHaveClass("opacity-0");

        post(frame().contentWindow, { type: "mike:ready" });
        expect(screen.queryByRole("status")).toBeNull();
        expect(frame()).not.toHaveClass("opacity-0");
        unmount();

        render(<VisualViewUI html={html} title="Rent chart" theme="light" />);
        fireEvent.load(frame());
        act(() => vi.advanceTimersByTime(1499));
        expect(screen.getByRole("status")).toBeInTheDocument();
        act(() => vi.advanceTimersByTime(1));
        expect(screen.queryByRole("status")).toBeNull();
    });
});
