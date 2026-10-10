import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    AssistantChatDivider,
    resizedSideChatShare,
} from "./AssistantChatDivider";

describe("resizedSideChatShare", () => {
    it("moves the boundary by the dragged distance", () => {
        // Dragging right narrows the side chat.
        expect(resizedSideChatShare(500, 500, 100)).toBe(0.4);
        expect(resizedSideChatShare(500, 500, -100)).toBe(0.6);
    });

    it("keeps both chats at their minimum width", () => {
        expect(resizedSideChatShare(500, 500, 400)).toBe(0.32);
        expect(resizedSideChatShare(500, 500, -400)).toBe(0.68);
    });

    it("splits evenly when two minimums do not fit", () => {
        expect(resizedSideChatShare(300, 200, 50)).toBe(0.5);
    });
});

describe("AssistantChatDivider", () => {
    it("reports the distance dragged", () => {
        const onResize = vi.fn();
        render(<AssistantChatDivider onResize={onResize} />);
        const divider = screen.getByRole("separator", { name: "Resize chats" });

        fireEvent.mouseDown(divider, { clientX: 400 });
        fireEvent.mouseMove(window, { clientX: 360 });
        fireEvent.mouseMove(window, { clientX: 380 });
        fireEvent.mouseUp(window);
        fireEvent.mouseMove(window, { clientX: 100 });

        expect(onResize.mock.calls).toEqual([[-40], [20]]);
    });

    it("resizes from the keyboard", () => {
        const onResize = vi.fn();
        render(<AssistantChatDivider onResize={onResize} />);
        const divider = screen.getByRole("separator", { name: "Resize chats" });

        fireEvent.keyDown(divider, { key: "ArrowLeft" });
        fireEvent.keyDown(divider, { key: "ArrowRight" });

        expect(onResize.mock.calls).toEqual([[-24], [24]]);
    });
});
