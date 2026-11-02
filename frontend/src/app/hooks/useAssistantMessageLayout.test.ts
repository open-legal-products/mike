import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantMessageLayout } from "./useAssistantMessageLayout";

function geometry() {
  const container = document.createElement("div");
  const userMessage = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 700 });
  Object.defineProperty(userMessage, "offsetHeight", {
    value: 60,
    configurable: true,
  });
  // The message's offsetParent is outside the scrolling container, so
  // offsetTop cannot be used to calculate its position in the viewport.
  Object.defineProperty(userMessage, "offsetTop", { value: 1200 });
  container.scrollTop = 200;
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
    top: 200,
  } as DOMRect);
  vi.spyOn(userMessage, "getBoundingClientRect").mockReturnValue({
    top: 1000,
  } as DOMRect);
  container.scrollTo = vi.fn();
  return { container, userMessage };
}

const options = {
  bottomPadding: 116,
  headerHeight: 48,
  messageCount: 4,
  chatKey: "chat-1",
};

describe("project assistant message layout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 1024);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("measures the response spacer when loaded messages replace the skeleton", () => {
    const { container, userMessage } = geometry();
    const containerRef = { current: null as HTMLDivElement | null };
    const userMessageRef = { current: null as HTMLDivElement | null };
    const { result, rerender } = renderHook(
      ({ ready }) =>
        useAssistantMessageLayout({
          ...options,
          containerRef,
          userMessageRef,
          ready,
        }),
      { initialProps: { ready: false } },
    );
    expect(result.current.minHeight).toBe("0px");
    containerRef.current = container;
    userMessageRef.current = userMessage;
    rerender({ ready: true });
    expect(result.current.minHeight).toBe("412px");
  });

  it("remeasures when switching between threads with equal message counts", () => {
    const { container, userMessage } = geometry();
    const containerRef = { current: container };
    const userMessageRef = { current: userMessage };
    const { result, rerender } = renderHook(
      ({ chatKey }) =>
        useAssistantMessageLayout({
          ...options,
          containerRef,
          userMessageRef,
          ready: true,
          chatKey,
        }),
      { initialProps: { chatKey: "chat-1" } },
    );
    expect(result.current.minHeight).toBe("412px");
    Object.defineProperty(userMessage, "offsetHeight", { value: 120 });
    rerender({ chatKey: "chat-2" });
    expect(result.current.minHeight).toBe("352px");
  });

  it("positions loaded and new user messages at the same top offset after layout", () => {
    const { container, userMessage } = geometry();
    const { result } = renderHook(() =>
      useAssistantMessageLayout({
        ...options,
        containerRef: { current: container },
        userMessageRef: { current: userMessage },
        ready: true,
      }),
    );
    const positioned = vi.fn();
    act(() => {
      result.current.scrollLatestUserToTop("auto", positioned);
    });
    expect(container.scrollTo).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(container.scrollTo).toHaveBeenLastCalledWith({
      top: 920,
      behavior: "auto",
    });
    expect(positioned).toHaveBeenCalledOnce();
    act(() => {
      result.current.scrollLatestUserToTop();
      vi.advanceTimersByTime(32);
    });
    expect(container.scrollTo).toHaveBeenLastCalledWith({
      top: 920,
      behavior: "smooth",
    });
  });

  it("leaves the header and a message gap above the user message on mobile", () => {
    vi.stubGlobal("innerWidth", 640);
    const { container, userMessage } = geometry();
    const { result } = renderHook(() =>
      useAssistantMessageLayout({
        ...options,
        containerRef: { current: container },
        userMessageRef: { current: userMessage },
        ready: true,
      }),
    );
    act(() => {
      result.current.scrollLatestUserToTop("auto");
      vi.advanceTimersByTime(32);
    });
    expect(container.scrollTo).toHaveBeenCalledWith({
      top: 928,
      behavior: "auto",
    });
  });

  it("cancels a pending initial position when the chat changes", () => {
    const { container, userMessage } = geometry();
    const { result } = renderHook(() =>
      useAssistantMessageLayout({
        ...options,
        containerRef: { current: container },
        userMessageRef: { current: userMessage },
        ready: true,
      }),
    );
    const positioned = vi.fn();
    act(() => {
      const cancel = result.current.scrollLatestUserToTop("auto", positioned);
      vi.advanceTimersByTime(16);
      cancel();
      vi.advanceTimersByTime(32);
    });
    expect(container.scrollTo).not.toHaveBeenCalled();
    expect(positioned).not.toHaveBeenCalled();
  });
});
