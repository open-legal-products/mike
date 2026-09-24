import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { AssistantMessage } from "./AssistantMessage";

describe("AssistantMessage copy", () => {
    beforeEach(() => clearToasts());

    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("tells the user when the clipboard refuses the copy", async () => {
        const user = userEvent.setup();
        // jsdom has no ClipboardItem; give the handler one so the failure
        // under test is the clipboard write itself, as it is in a browser.
        vi.stubGlobal(
            "ClipboardItem",
            class {
                constructor(public items: Record<string, Blob>) {}
            },
        );
        const write = vi
            .fn()
            .mockRejectedValue(
                new DOMException("Write permission denied.", "NotAllowedError"),
            );
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { ...navigator.clipboard, write },
        });

        render(
            <>
                <AssistantMessage
                    events={[{ type: "content", text: "The answer." }]}
                />
                <ToastViewportUI />
            </>,
        );

        await user.click(screen.getByRole("button", { name: "Copy response" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't copy this answer");
        expect(alert).toHaveTextContent("clipboard permission");
        expect(alert).not.toHaveTextContent("Write permission denied.");
        expect(
            screen.queryByRole("button", { name: "Response copied" }),
        ).not.toBeInTheDocument();
        vi.unstubAllGlobals();
    });
});
