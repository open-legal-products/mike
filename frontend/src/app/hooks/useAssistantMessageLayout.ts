"use client";

import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

const USER_MESSAGE_TOP_OFFSET = 24;

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the response spacer depends on rendered message geometry
    setMinHeight(
      `${Math.max(0, container.clientHeight - messageGap * 3 - userMessage.offsetHeight - bottomPadding - headerHeight)}px`,
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
          container.scrollTo({
            top: userMessage.offsetTop - USER_MESSAGE_TOP_OFFSET,
            behavior,
          });
          onPositioned?.();
        });
      });
      return () => cancelAnimationFrame(frame);
    },
    [containerRef, userMessageRef],
  );

  return { minHeight, scrollLatestUserToTop };
}
