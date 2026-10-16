import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreResponseWrapperUI } from "./PreResponseWrapperUI";

describe("PreResponseWrapperUI", () => {
    it("shows streaming activity and lets the user collapse it", async () => {
        const user = userEvent.setup();

        render(
            <PreResponseWrapperUI
                stepCount={2}
                shouldMinimize={false}
                isStreaming
            >
                <div>Reading document</div>
            </PreResponseWrapperUI>,
        );

        const toggle = screen.getByRole("button", { name: "Working" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(toggle).toHaveClass("text-sm");
        expect(screen.getByText("Reading document").parentElement).toHaveClass(
            "gap-4",
        );

        await user.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Reading document")).toBeNull();
    });

    it("renders a minimized completion summary and supports forceOpen", async () => {
        const { rerender } = render(
            <PreResponseWrapperUI
                stepCount={1}
                shouldMinimize
                isStreaming={false}
            >
                <div>Read agreement</div>
            </PreResponseWrapperUI>,
        );

        expect(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        ).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText("Read agreement")).toBeNull();

        rerender(
            <PreResponseWrapperUI
                stepCount={1}
                shouldMinimize
                isStreaming={false}
                forceOpen
            >
                <div>Read agreement</div>
            </PreResponseWrapperUI>,
        );

        expect(await screen.findByText("Read agreement")).toBeVisible();
    });
});

describe("activity scroll fade", () => {
    let frames: Map<number, FrameRequestCallback>;
    let nextFrame: number;
    let observers: Map<Element, () => void>;

    beforeEach(() => {
        frames = new Map();
        nextFrame = 0;
        observers = new Map();
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            frames.set(++nextFrame, callback);
            return nextFrame;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
        vi.stubGlobal("ResizeObserver", class {
            elements = new Set<Element>();
            constructor(private resize: () => void) {}
            observe(element: Element) {
                this.elements.add(element);
                observers.set(element, this.resize);
            }
            disconnect() {
                for (const element of this.elements) observers.delete(element);
            }
        });
    });

    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    function flushFrame() {
        act(() => {
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach(callback => callback(16));
        });
    }

    function activity(text = "Reading documents") {
        return <StrictMode>
            <PreResponseWrapperUI stepCount={1} shouldMinimize={false} isStreaming>
                <div>{text}</div>
            </PreResponseWrapperUI>
        </StrictMode>;
    }

    const fade = () => document.querySelector('[data-slot="activity-scroll-fade"]');

    it("fades only unread overflow and updates as events grow or the viewport resizes", () => {
        render(activity());
        const viewport = screen.getByRole("region", { name: "Assistant activity" });
        const content = viewport.firstElementChild!;
        const size = { content: 80, viewport: 320 };
        Object.defineProperties(viewport, {
            scrollHeight: { get: () => size.content },
            clientHeight: { get: () => size.viewport },
        });
        flushFrame();
        expect(fade()).not.toBeInTheDocument();

        size.content = 600;
        observers.get(content)!();
        flushFrame();
        expect(fade()).toBeVisible();
        expect(fade()).toHaveAttribute("aria-hidden", "true");
        expect(fade()).toHaveClass("pointer-events-none");
        viewport.scrollTop = 280;
        fireEvent.scroll(viewport);
        flushFrame();
        expect(fade()).not.toBeInTheDocument();

        size.content = 800;
        observers.get(content)!();
        flushFrame();
        expect(fade()).toBeVisible();
        size.viewport = 800;
        observers.get(viewport)!();
        flushFrame();
        expect(fade()).not.toBeInTheDocument();
    });

    it("coalesces measurements during streaming and cleans up when collapsed or unmounted", () => {
        const view = render(activity());
        const viewport = screen.getByRole("region", { name: "Assistant activity" });
        const content = viewport.firstElementChild!;
        const readHeight = vi.fn(() => 600);
        Object.defineProperties(viewport, {
            scrollHeight: { get: readHeight },
            clientHeight: { get: () => 320 },
        });
        flushFrame();
        readHeight.mockClear();
        for (let chunk = 0; chunk < 300; chunk++) view.rerender(activity(`Event ${chunk}`));
        expect(readHeight).not.toHaveBeenCalled();
        for (let notification = 0; notification < 300; notification++) observers.get(content)!();
        expect(frames.size).toBe(1);
        flushFrame();
        expect(readHeight).toHaveBeenCalledTimes(1);

        const resize = observers.get(content)!;
        resize();
        fireEvent.click(screen.getByRole("button", { name: "Working" }));
        expect(frames.size).toBe(0);
        expect(observers.size).toBe(0);
        resize();
        fireEvent.scroll(viewport);
        expect(frames.size).toBe(0);

        fireEvent.click(screen.getByRole("button", { name: "Working" }));
        expect(observers.size).toBe(2);
        expect(frames.size).toBe(1);
        view.unmount();
        expect(observers.size).toBe(0);
        expect(frames.size).toBe(0);
    });
});
