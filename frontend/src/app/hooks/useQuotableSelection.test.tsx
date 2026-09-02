import { useRef } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
    QUOTABLE_ATTRIBUTE,
    useQuotableSelection,
} from "./useQuotableSelection";

/**
 * Harness mirroring a chat surface: a scroll container holding one quotable
 * assistant response, one non-quotable user bubble, and a composer textarea.
 */
function Harness({ enabled = true }: { enabled?: boolean }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const { selection, clear } = useQuotableSelection(containerRef, {
        enabled,
    });
    return (
        <div>
            <div ref={containerRef}>
                <div {...{ [QUOTABLE_ATTRIBUTE]: "" }} data-testid="assistant">
                    <p data-testid="para-one">The indemnity clause applies.</p>
                    <p data-testid="para-two">A second paragraph here.</p>
                </div>
                <div {...{ [QUOTABLE_ATTRIBUTE]: "" }} data-testid="assistant-2">
                    <p data-testid="para-three">Later response text.</p>
                </div>
                <div data-testid="user">What the user typed earlier.</div>
            </div>
            <textarea data-testid="composer" defaultValue="composer draft" />
            <div data-testid="outside">Page chrome text.</div>
            <output data-testid="captured">{selection?.text ?? "(none)"}</output>
            <button type="button" onClick={clear}>
                clear
            </button>
        </div>
    );
}

/** Select from the start of `startEl`'s text to the end of `endEl`'s text. */
function selectAcross(startEl: HTMLElement, endEl: HTMLElement) {
    const range = document.createRange();
    range.setStart(startEl.firstChild!, 0);
    range.setEnd(endEl.firstChild!, endEl.textContent!.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
}

function selectWithin(el: HTMLElement, start: number, end: number) {
    const range = document.createRange();
    range.setStart(el.firstChild!, start);
    range.setEnd(el.firstChild!, end);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
}

function finishDrag() {
    act(() => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
}

const captured = () => screen.getByTestId("captured").textContent;

afterEach(() => {
    window.getSelection()?.removeAllRanges();
});

describe("useQuotableSelection", () => {
    it("captures a selection made inside an assistant response", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 4, 19);
        finishDrag();
        expect(captured()).toBe("indemnity claus");
    });

    it("normalizes whitespace across element boundaries", () => {
        render(<Harness />);
        selectAcross(
            screen.getByTestId("para-one"),
            screen.getByTestId("para-two"),
        );
        finishDrag();
        expect(captured()).toBe(
            "The indemnity clause applies.A second paragraph here.",
        );
    });

    it("ignores a selection inside a user bubble", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("user"), 0, 8);
        finishDrag();
        expect(captured()).toBe("(none)");
    });

    it("ignores a selection outside the watched container", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("outside"), 0, 4);
        finishDrag();
        expect(captured()).toBe("(none)");
    });

    it("ignores a collapsed selection (a plain click)", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 5, 5);
        finishDrag();
        expect(captured()).toBe("(none)");
    });

    it("ignores a selection that is only whitespace", () => {
        render(
            <Harness />,
        );
        const para = screen.getByTestId("para-one");
        // The single space between "The" and "indemnity".
        selectWithin(para, 3, 4);
        finishDrag();
        expect(captured()).toBe("(none)");
    });

    it("clamps a selection that runs into the next response", () => {
        render(<Harness />);
        selectAcross(
            screen.getByTestId("para-two"),
            screen.getByTestId("para-three"),
        );
        finishDrag();
        // Collapsed to the bubble the drag started in.
        expect(captured()).toBe("A second paragraph here.");
    });

    it("clamps a selection that starts in a response and ends in chrome", () => {
        render(<Harness />);
        selectAcross(
            screen.getByTestId("para-one"),
            screen.getByTestId("user"),
        );
        finishDrag();
        expect(captured()).toBe(
            "The indemnity clause applies.A second paragraph here.",
        );
    });

    it("drops the selection when it collapses", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        finishDrag();
        expect(captured()).toBe("The");

        act(() => {
            window.getSelection()!.removeAllRanges();
            document.dispatchEvent(new Event("selectionchange"));
        });
        expect(captured()).toBe("(none)");
    });

    it("drops the selection on Escape", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        finishDrag();
        expect(captured()).toBe("The");

        act(() => {
            document.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Escape" }),
            );
        });
        expect(captured()).toBe("(none)");
    });

    it("drops the selection on scroll", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        finishDrag();
        expect(captured()).toBe("The");

        act(() => {
            screen
                .getByTestId("assistant")
                .dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        expect(captured()).toBe("(none)");
    });

    it("drops the selection on resize", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        finishDrag();
        act(() => {
            window.dispatchEvent(new Event("resize"));
        });
        expect(captured()).toBe("(none)");
    });

    it("stays cleared after clear() until the selection changes", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        finishDrag();
        expect(captured()).toBe("The");

        act(() => {
            screen.getByText("clear").click();
        });
        expect(captured()).toBe("(none)");

        // The browser still holds the same range; re-detecting it would make
        // the popup pop straight back up after the user consumed it.
        finishDrag();
        expect(captured()).toBe("(none)");

        // Collapsing re-arms detection.
        act(() => {
            window.getSelection()!.removeAllRanges();
            document.dispatchEvent(new Event("selectionchange"));
        });
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        finishDrag();
        expect(captured()).toBe("The");
    });

    it("captures a shift-key keyboard selection", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        act(() => {
            document.dispatchEvent(
                new KeyboardEvent("keyup", {
                    key: "ArrowRight",
                    shiftKey: true,
                }),
            );
        });
        expect(captured()).toBe("The");
    });

    it("does not capture on an ordinary keyup", () => {
        render(<Harness />);
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        act(() => {
            document.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
        });
        expect(captured()).toBe("(none)");
    });

    it("captures nothing while disabled", () => {
        render(<Harness enabled={false} />);
        selectWithin(screen.getByTestId("para-one"), 0, 3);
        finishDrag();
        expect(captured()).toBe("(none)");
    });
});
