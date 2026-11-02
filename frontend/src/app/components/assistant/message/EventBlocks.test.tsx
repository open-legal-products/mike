import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    AskInputsBlock,
    CourtListenerBlock,
    DocDownloadBlock,
    ReasoningBlock,
} from "./EventBlocks";

describe("reasoning scroll fade", () => {
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

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    function flushFrame() {
        act(() => {
            const pending = [...frames.values()];
            frames.clear();
            pending.forEach((callback) => callback(16));
        });
    }

    function geometry() {
        const viewport = screen.getByRole("region", { name: "Thought process" });
        const content = viewport.firstElementChild!;
        const size = { content: 80, viewport: 144 };
        const readHeight = vi.fn(() => size.content);
        Object.defineProperties(viewport, {
            scrollHeight: { configurable: true, get: readHeight },
            clientHeight: { configurable: true, get: () => size.viewport },
        });
        return { viewport, content, size, readHeight };
    }

    const scrollFade = () => document.querySelector('[data-slot="reasoning-scroll-fade"]');

    it("shows only when more content is below, including streaming growth and resize", () => {
        render(<ReasoningBlock text="Reviewing the terms." isStreaming />);
        const { viewport, content, size } = geometry();
        flushFrame();
        expect(scrollFade()).not.toBeInTheDocument();

        size.content = 600;
        act(() => observers.get(content)?.());
        flushFrame();
        expect(scrollFade()).toBeVisible();
        expect(scrollFade()).toHaveAttribute("aria-hidden", "true");
        expect(scrollFade()).toHaveClass("pointer-events-none");

        viewport.scrollTop = 456;
        fireEvent.scroll(viewport);
        flushFrame();
        expect(scrollFade()).not.toBeInTheDocument();

        // New streamed reasoning extends beyond the previous bottom.
        size.content = 800;
        act(() => observers.get(content)?.());
        flushFrame();
        expect(scrollFade()).toBeVisible();

        size.viewport = 800;
        act(() => observers.get(viewport)?.());
        flushFrame();
        expect(scrollFade()).not.toBeInTheDocument();
    });

    it("does not remeasure on text updates and cleans up when closed or unmounted", () => {
        const view = render(<StrictMode><ReasoningBlock text="First chunk" isStreaming /></StrictMode>);
        const { viewport, content, readHeight } = geometry();
        flushFrame();
        readHeight.mockClear();
        for (let chunk = 0; chunk < 300; chunk++) {
            view.rerender(<StrictMode><ReasoningBlock text={`Chunk ${chunk}`} isStreaming /></StrictMode>);
        }
        expect(readHeight).not.toHaveBeenCalled();
        expect(frames.size).toBe(0);

        // A burst of layout and scroll notifications shares one measurement.
        act(() => {
            for (let i = 0; i < 300; i++) observers.get(content)?.();
            observers.get(viewport)?.();
            fireEvent.scroll(viewport);
        });
        expect(frames.size).toBe(1);
        flushFrame();
        readHeight.mockClear();

        const pendingResize = observers.get(content)!;
        act(pendingResize);
        fireEvent.click(screen.getByRole("button", { name: "Thinking..." }));
        expect(frames.size).toBe(0);
        expect(observers.size).toBe(0);
        act(pendingResize);
        fireEvent.scroll(viewport);
        flushFrame();
        expect(readHeight).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Thinking..." }));
        expect(observers.size).toBe(2);
        expect(frames.size).toBe(1);
        view.unmount();
        expect(observers.size).toBe(0);
        expect(frames.size).toBe(0);
    });
});

describe("DocDownloadBlock", () => {
    it("shows the file icon without a file-type label", () => {
        const { container } = render(
            <DocDownloadBlock
                filename="agreement.docx"
                download_url="/documents/agreement/download"
                versionNumber={2}
            />,
        );

        const name = screen.getByText("agreement");
        // Compact by default; the full size applies only in a wide container.
        expect(name).toHaveClass("truncate", "text-sm", "@md:text-lg");
        expect(name).toHaveAttribute("title", "agreement");
        expect(screen.queryByText("DOCX")).not.toBeInTheDocument();
        expect(
            container.querySelector(
                'img[src*="/icons/file-types/word.svg"]',
            ),
        ).toHaveClass("h-3.5", "w-3.5", "@md:h-4", "@md:w-4");
    });
});

describe("AskInputsBlock", () => {
    it("collapses completed input details and toggles them from the label", () => {
        render(
            <AskInputsBlock
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [
                        {
                            id: "address",
                            kind: "text",
                            question: "What is the registered address?",
                        },
                    ],
                }}
                response={{
                    type: "ask_inputs_response",
                    assistant_message_id: "assistant-1",
                    ask_event_id: "ask-1",
                    responses: [
                        {
                            id: "address",
                            kind: "text",
                            question: "What is the registered address?",
                            answer: "1 Legal Plaza",
                        },
                    ],
                }}
            />,
        );

        const toggle = screen.getByRole("button", {
            name: "Asked for input",
        });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByText("What is the registered address?"),
        ).not.toBeInTheDocument();

        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByText("What is the registered address?"),
        ).toBeInTheDocument();
        expect(screen.getByText("1 Legal Plaza")).toBeInTheDocument();

        fireEvent.click(toggle);
        expect(
            screen.queryByText("What is the registered address?"),
        ).not.toBeInTheDocument();
    });
});

describe("event line consistency", () => {
    it("uses one chevron direction and always reports expansion", () => {
        const { container, unmount } = render(
            <AskInputsBlock
                event={{
                    type: "ask_inputs",
                    event_id: "ask-1",
                    items: [
                        {
                            id: "venue",
                            kind: "text",
                            question: "Which venue?",
                        },
                    ],
                }}
            />,
        );

        // Unanswered blocks open by default: chevron down, nothing rotated.
        const toggle = screen.getByRole("button", { name: "Asking for input" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(container.querySelector("svg.-rotate-90")).toBeNull();

        // Closed points right — the direction every other block uses.
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(container.querySelector("svg.-rotate-90")).not.toBeNull();
        unmount();

        const research = render(
            <CourtListenerBlock
                label="Searched case law"
                items={[
                    {
                        caseName: "Donoghue v Stevenson",
                        citation: "[1932] AC 562",
                        url: "https://x.test",
                    },
                ]}
            />,
        );
        const search = screen.getByRole("button", {
            name: /Searched case law/,
        });
        // This one used to ship without any expansion state at all.
        expect(search).toHaveAttribute("aria-expanded", "false");
        expect(
            research.container.querySelector("svg.-rotate-90"),
        ).not.toBeNull();
    });
});
