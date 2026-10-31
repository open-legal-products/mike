import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const parsed = vi.hoisted(() => ({ values: [] as string[] }));
vi.mock("../../../word-addin/src/shared/chat/Markdown", () => ({
  Markdown: React.memo(function MockMarkdown({ children }: { children: string }) {
    parsed.values.push(children);
    return <div data-testid="rich">{children}</div>;
  }),
}));
import { ProseBlock } from "../../../word-addin/src/taskpane/components/assistant/message/ProseBlock";
const onClick = () => {};
beforeEach(() => { parsed.values = []; });
it.each([32_768, 65_536, 131_072])("bounds rich parse bytes while every appended character stays visible (%s)", length => {
  const props = { citations: undefined, onClick, isStreaming: true };
  const view = render(<ProseBlock {...props} text="" />);
  // Performance assertion counts actual rich-render inputs, not hook updates.
  for (let size = 1024; size <= length; size += 1024) {
    const text = "x".repeat(size);
    view.rerender(<ProseBlock {...props} text={text} />);
    expect(view.container.textContent).toBe(text);
  }
  view.rerender(<ProseBlock {...props} text={"x".repeat(length)} isStreaming={false} />);
  expect(view.getByTestId("rich").textContent).toBe("x".repeat(length));
  expect(parsed.values.reduce((sum, text) => sum + text.length, 0)).toBeLessThan(8 * length);
  const count = parsed.values.length;
  view.rerender(<ProseBlock {...props} text={"x".repeat(length)} isStreaming={false} />);
  expect(parsed.values).toHaveLength(count);
  view.unmount();
});
it("shows plain tails immediately and flushes rewrites and completion without duplication", () => {
  const prefix = "x".repeat(9000);
  const props = { citations: undefined, onClick, isStreaming: true };
  const view = render(<ProseBlock {...props} text={prefix} />);
  const tail = "\n**complete**\n[reference][id]\n[id]: https://example.test\n<script>private</script>";
  view.rerender(<ProseBlock {...props} text={prefix + tail} />);
  expect(parsed.values).toEqual([prefix]);
  expect(view.container.textContent).toBe(prefix + tail);
  expect(view.container.querySelector("script")).toBeNull();
  // A tool boundary passes false just like completion, sealing canonical Markdown.
  view.rerender(<ProseBlock {...props} text={prefix + tail} isStreaming={false} />);
  expect(parsed.values.at(-1)).toBe(prefix + tail);
  expect(view.container.textContent).toBe(prefix + tail);
  view.rerender(<ProseBlock {...props} text="replacement" />);
  expect(view.getByTestId("rich").textContent).toBe("replacement");
});
