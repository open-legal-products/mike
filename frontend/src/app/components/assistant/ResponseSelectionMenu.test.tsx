import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    EXCERPT_SOURCE_PROPS,
    ResponseSelectionMenu,
} from "./ResponseSelectionMenu";

function renderThread(canAsk = true) {
    const onAddExcerpt = vi.fn();
    render(
        <>
            <p {...EXCERPT_SOURCE_PROPS}>The notice period is 30 days.</p>
            <p>Text outside any response.</p>
            <ResponseSelectionMenu
                canAsk={canAsk}
                onAddExcerpt={onAddExcerpt}
            />
        </>,
    );
    return onAddExcerpt;
}

/** Highlights `text` and releases the mouse, as a reader would. */
async function highlight(text: string) {
    const node = screen.getByText(text);
    window.getSelection()?.selectAllChildren(node);
    fireEvent.mouseUp(node, { clientX: 40, clientY: 60 });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe("ResponseSelectionMenu", () => {
    beforeEach(() => {
        window.getSelection()?.removeAllRanges();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("offers copy, ask and annotate for highlighted response text", async () => {
        renderThread();
        await highlight("The notice period is 30 days.");

        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent),
        ).toEqual(["Copy", "Ask", "Annotate and ask"]);
    });

    it("stays closed for a selection outside a response", async () => {
        renderThread();
        await highlight("Text outside any response.");

        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("copies the highlighted text", async () => {
        const writeText = vi.fn(async () => undefined);
        vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
        renderThread();
        await highlight("The notice period is 30 days.");

        fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
        expect(writeText).toHaveBeenCalledWith("The notice period is 30 days.");
    });

    it("adds a plain excerpt on Ask", async () => {
        const onAddExcerpt = renderThread();
        await highlight("The notice period is 30 days.");

        fireEvent.click(screen.getByRole("menuitem", { name: "Ask" }));
        expect(onAddExcerpt).toHaveBeenCalledWith({
            text: "The notice period is 30 days.",
        });
    });

    it("collects a note and adds the annotated excerpt", async () => {
        const user = userEvent.setup();
        const onAddExcerpt = renderThread();
        await highlight("The notice period is 30 days.");

        fireEvent.click(
            screen.getByRole("menuitem", { name: "Annotate and ask" }),
        );
        const note = await screen.findByRole("textbox", {
            name: "Note about the selected text",
        });
        const submit = screen.getByRole("button", {
            name: "Add annotation to chat",
        });
        expect(submit).toBeDisabled();

        await user.type(note, "Is this enforceable?{Enter}");

        expect(onAddExcerpt).toHaveBeenCalledWith({
            text: "The notice period is 30 days.",
            note: "Is this enforceable?",
        });
        expect(
            screen.queryByRole("textbox", {
                name: "Note about the selected text",
            }),
        ).toBeNull();
    });

    it("closes the note on Escape without adding anything", async () => {
        const user = userEvent.setup();
        const onAddExcerpt = renderThread();
        await highlight("The notice period is 30 days.");

        fireEvent.click(
            screen.getByRole("menuitem", { name: "Annotate and ask" }),
        );
        const note = await screen.findByRole("textbox", {
            name: "Note about the selected text",
        });
        await user.type(note, "Draft{Escape}");

        expect(onAddExcerpt).not.toHaveBeenCalled();
        expect(
            screen.queryByRole("textbox", {
                name: "Note about the selected text",
            }),
        ).toBeNull();
    });

    it("keeps the note inside the window when it is resized", async () => {
        const originalWidth = window.innerWidth;
        try {
            window.innerWidth = 1024;
            renderThread();
            const node = screen.getByText("The notice period is 30 days.");
            window.getSelection()?.selectAllChildren(node);
            fireEvent.mouseUp(node, { clientX: 900, clientY: 60 });
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            fireEvent.click(
                screen.getByRole("menuitem", { name: "Annotate and ask" }),
            );
            const note = await screen.findByRole("textbox", {
                name: "Note about the selected text",
            });
            const bubble = note.closest<HTMLElement>("[data-excerpt-bubble]")!;
            // 320px wide with an 8px margin: clamped off the right edge.
            expect(bubble.style.left).toBe("696px");

            window.innerWidth = 500;
            fireEvent(window, new Event("resize"));
            expect(bubble.style.left).toBe("172px");
        } finally {
            window.innerWidth = originalWidth;
        }
    });

    it("offers only Copy to a reader who cannot send", async () => {
        renderThread(false);
        await highlight("The notice period is 30 days.");

        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent),
        ).toEqual(["Copy"]);
    });
});
