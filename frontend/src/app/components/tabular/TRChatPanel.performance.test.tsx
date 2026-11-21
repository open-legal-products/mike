import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRMessageBubble } from "./TRChatPanel";
const parsed = vi.hoisted(() => vi.fn());
vi.mock("react-markdown", async importOriginal => {
    const original = await importOriginal<typeof import("react-markdown")>();
    return {...original, default: (props: import("react-markdown").Options) => {parsed(props.children); return <original.default {...props} />;}};
});

describe("tabular chat streaming work", () => {
    beforeEach(() => parsed.mockClear());
    it("skips completed bubbles during drip updates", () => {
        const msg = {role: "assistant" as const, content: "", events: [{type: "content" as const, text: "Old answer"}]};
        const onCitationClick = vi.fn();
        const {rerender} = render(<TRMessageBubble msg={msg} onCitationClick={onCitationClick} />);
        for (let tick = 0; tick < 100; tick++) rerender(<TRMessageBubble msg={msg} onCitationClick={onCitationClick} />);
        expect(parsed).toHaveBeenCalledTimes(1);
    });
    it("keeps all drip text visible while parsing only checkpoints and flushes on completion", () => {
        const prefix = "a".repeat(9000);
        const message = (text: string, isStreaming = true) => ({role: "assistant" as const, content: "", isStreaming, events: [{type: "content" as const, text}]});
        const onCitationClick = vi.fn();
        const {container, rerender} = render(<TRMessageBubble msg={message(prefix)} onCitationClick={onCitationClick} />);
        const tail = " **finished** <script>bad()</script>";
        for (let size = 1; size <= tail.length; size++) {
            rerender(<TRMessageBubble msg={message(prefix + tail.slice(0, size))} onCitationClick={onCitationClick} />);
            expect(container.textContent).toContain(prefix + tail.slice(0, size));
        }
        expect(parsed).toHaveBeenCalledTimes(1);
        expect(container.querySelector("script")).toBeNull();
        rerender(<TRMessageBubble msg={message(prefix + tail, false)} onCitationClick={onCitationClick} />);
        expect(parsed).toHaveBeenCalledTimes(2);
        expect(container.querySelector("strong")).toHaveTextContent("finished");
        expect(container.querySelector("script")).toBeNull();
    });
});
