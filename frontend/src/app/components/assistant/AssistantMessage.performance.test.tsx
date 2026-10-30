import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent, Citation } from "../shared/types";
const parsed = vi.hoisted(() => vi.fn());
vi.mock("./message/useSmoothedReveal", () => ({useSmoothedReveal: (text: string) => text}));
vi.mock("react-markdown", async importOriginal => {
    const original = await importOriginal<typeof import("react-markdown")>();
    return {...original, default: (props: import("react-markdown").Options) => {parsed(props.children); return <original.default {...props} />;}};
});

describe("assistant streaming work isolation", () => {
    beforeEach(() => parsed.mockClear());
    it("does not reparse historical messages when parent callbacks change", () => {
        const events: AssistantEvent[] = [{type: "content", text: "Completed **answer**."}];
        const {rerender} = render(<AssistantMessage events={events} onCitationClick={() => {}} />);
        for (let tick = 0; tick < 30; tick++) rerender(<AssistantMessage events={events} onCitationClick={() => {}} />);
        expect(parsed).toHaveBeenCalledTimes(1);
    });
    it("dispatches citation clicks to the latest callback even when history stays memoized", () => {
        const events: AssistantEvent[] = [{type: "content", text: "See [1]."}];
        const citations: Citation[] = [{type: "citation_data", ref: 1, doc_id: "doc", document_id: "doc", filename: "Evidence", page: 1, quote: "Source"}];
        const first = vi.fn();
        const latest = vi.fn();
        const {container, rerender} = render(<AssistantMessage events={events} citations={citations} onCitationClick={first} />);
        rerender(<AssistantMessage events={events} citations={citations} onCitationClick={latest} />);
        fireEvent.click(container.querySelector('[data-citation-ref="1"]')!);
        expect(first).not.toHaveBeenCalled();
        expect(latest).toHaveBeenCalledWith(citations[0]);
        expect(parsed).toHaveBeenCalledTimes(1);
    });
    it("renders a safe immediate tail without reprocessing its rich prefix, then flushes canonical formatting", () => {
        const prefix = "x".repeat(9000);
        const event = (text: string): AssistantEvent[] => [{type: "content", text}];
        const {container, rerender} = render(<AssistantMessage events={event(prefix)} isStreaming />);
        const count = parsed.mock.calls.length;
        const tail = " **bold** <script>bad()</script>";
        rerender(<AssistantMessage events={event(prefix + tail)} isStreaming />);
        expect(parsed).toHaveBeenCalledTimes(count);
        expect(container.textContent).toContain(prefix + tail);
        expect(container.querySelector("script")).toBeNull();
        rerender(<AssistantMessage events={event(prefix + tail)} isStreaming={false} />);
        expect(parsed).toHaveBeenCalledTimes(count + 1);
        expect(container.querySelector("strong")).toHaveTextContent("bold");
        expect(container.querySelector("script")).toBeNull();
    });
    it("flushes a pending content tail when a tool starts", () => {
        const prefix = "a".repeat(9000);
        const {container, rerender} = render(<AssistantMessage events={[{type: "content", text: prefix}]} isStreaming />);
        rerender(<AssistantMessage events={[{type: "content", text: prefix + " **done**"}, {type: "thinking", isStreaming: true}]} isStreaming />);
        expect(container.querySelector("strong")).toHaveTextContent("done");
    });
});
