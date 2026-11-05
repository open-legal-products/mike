import { StrictMode, useLayoutEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReasoningDisclosure } from "./useReasoningDisclosure";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let height: number;
let measurements: ReturnType<typeof vi.fn<() => number>>;
let observers: { resize: () => void; disconnect: ReturnType<typeof vi.fn> }[];
let commits: number;

function Harness({ streaming = true, text = "Reasoning" }) {
    const disclosure = useReasoningDisclosure(streaming);
    useLayoutEffect(() => { commits++; });
    return <>
        <button aria-expanded={disclosure.isContentOpen} onClick={disclosure.toggleContent}>Thought process</button>
        {disclosure.isContentOpen && <div ref={disclosure.contentRef}>{text}</div>}
        <output>{disclosure.isOverflowing ? "overflow" : "fits"}</output>
        <button onClick={() => disclosure.setIsExpanded(!disclosure.isExpanded)}>
            {disclosure.isExpanded ? "Minimise" : "Expand"}
        </button>
    </>;
}

function flushFrame() {
    act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(16));
    });
}

beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    height = 24;
    commits = 0;
    observers = [];
    measurements = vi.fn(() => height);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(measurements);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", class {
        disconnect = vi.fn();
        observe = vi.fn();
        constructor(resize: () => void) { observers.push({ resize, disconnect: this.disconnect }); }
    });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("reasoning disclosure", () => {
    it("does not remeasure or dispatch state for 300 text chunks without a size change", () => {
        const view = render(<Harness />);
        flushFrame();
        const initialCommits = commits;
        for (let i = 0; i < 300; i++) view.rerender(<Harness text={`Chunk ${i}`} />);
        expect(measurements).toHaveBeenCalledTimes(1);
        expect(observers).toHaveLength(1);
        expect(frames.size).toBe(0);
        expect(commits).toBe(initialCommits + 300);
    });

    it("coalesces resize notifications and dispatches only overflow transitions", () => {
        render(<Harness />);
        flushFrame();
        const initialCommits = commits;
        for (let i = 0; i < 300; i++) observers[0].resize();
        expect(frames.size).toBe(1);
        flushFrame();
        expect(commits).toBe(initialCommits);
        height = 300;
        observers[0].resize();
        flushFrame();
        expect(screen.getByText("overflow")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Expand" }));
        height = 24;
        observers[0].resize();
        flushFrame();
        expect(screen.getByText("fits")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
        height = 300;
        observers[0].resize();
        flushFrame();
        expect(screen.getByText("overflow")).toBeInTheDocument();
    });

    it("follows streaming until explicitly toggled, including completion and restart", () => {
        const view = render(<Harness streaming={false} />);
        expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
        expect(observers).toHaveLength(0);
        view.rerender(<Harness />);
        expect(screen.getByText("Reasoning")).toBeInTheDocument();
        view.rerender(<Harness streaming={false} />);
        expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
        view.rerender(<Harness />);
        view.rerender(<Harness streaming={false} />);
        expect(screen.getByText("Reasoning")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
        view.rerender(<Harness />);
        expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
    });

    it("remeasures after reopening and cleans up pending work in Strict Mode", () => {
        const view = render(<StrictMode><Harness /></StrictMode>);
        expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
        expect(frames.size).toBe(1);
        flushFrame();
        fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
        height = 300;
        fireEvent.click(screen.getByRole("button", { name: "Thought process" }));
        flushFrame();
        expect(screen.getByText("overflow")).toBeInTheDocument();
        observers.at(-1)!.resize();
        expect(frames.size).toBe(1);
        view.unmount();
        expect(frames.size).toBe(0);
        for (const observer of observers) {
            expect(observer.disconnect).toHaveBeenCalledTimes(1);
            observer.resize();
        }
        expect(frames.size).toBe(0);
    });
});
