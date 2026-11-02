"use client";

import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

interface Options {
  containerRef: RefObject<HTMLDivElement | null>;
  userMessageRef: RefObject<HTMLDivElement | null>;
  ready: boolean;
  messageCount: number;
  chatKey: string;
  bottomPadding: number;
  headerHeight: number;
}

export function useAssistantMessageLayout({
  containerRef,
  userMessageRef,
  ready,
  messageCount,
  chatKey,
  bottomPadding,
  headerHeight,
}: Options) {
  const [minHeight, setMinHeight] = useState("0px");

  useLayoutEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    const userMessage = userMessageRef.current;
    if (!container || !userMessage) return;
    const messageGap = window.innerWidth < 768 ? 24 : 32;
    // Measure after the loading skeleton gives way to the messages, even
    // when selecting a thread with the same number of messages.
    setMinHeight(
      `${Math.max(0, container.clientHeight - messageGap * 2 - userMessage.offsetHeight - bottomPadding - headerHeight)}px`,
    );
  }, [
    ready,
    messageCount,
    chatKey,
    bottomPadding,
    headerHeight,
    containerRef,
    userMessageRef,
  ]);

  const scrollLatestUserToTop = useCallback(
    (behavior: ScrollBehavior = "smooth", onPositioned?: () => void) => {
      let frame = requestAnimationFrame(() => {
        // The spacer must be committed before scrolling; otherwise the
        // browser clamps a short saved response below the desired top.
        frame = requestAnimationFrame(() => {
          const container = containerRef.current;
          const userMessage = userMessageRef.current;
          if (!container || !userMessage) return;
          const messageGap = window.innerWidth < 768 ? 24 : 32;
          const topOffset = headerHeight + messageGap;
          // offsetTop may be relative to the entire panel rather than its
          // scrolling viewport. Measure both elements in the same coordinates.
          const messageTop =
            userMessage.getBoundingClientRect().top -
            container.getBoundingClientRect().top +
            container.scrollTop;
          container.scrollTo({
            top: Math.max(0, messageTop - topOffset),
            behavior,
          });
          onPositioned?.();
        });
      });
      return () => cancelAnimationFrame(frame);
    },
    [containerRef, userMessageRef, headerHeight],
  );

  return { minHeight, scrollLatestUserToTop };
}
