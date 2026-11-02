import React, { useEffect, useState, type ReactNode } from "react";
import { useReasoningDisclosure } from "@mike/reasoning-disclosure";
import { ChevronDown } from "lucide-react";
import {
  DocFindBlockUI,
  DocReadBlockUI,
} from "@mike/document-event-blocks-ui";
import { Markdown } from "../../../../shared/chat/Markdown";

const THINKING_PHRASES = [
  "Thinking...",
  "Pondering...",
  "Analyzing...",
  "Reviewing...",
  "Reasoning...",
];
const REASONING_COLLAPSED_MAX_HEIGHT_REM = 9;

function EventConnector(): React.ReactElement {
  return (
    <div className="absolute left-[3px] top-[14px] h-[calc(100%+10px)] w-[1px] translate-x-[-50%] bg-gray-300" />
  );
}

export function EventBlock({
  showConnector,
  isStreaming,
  dotColor = "green",
  children,
}: {
  showConnector?: boolean;
  isStreaming?: boolean;
  dotColor?: "green" | "gray" | "red";
  children: ReactNode;
}): React.ReactElement {
  const dotColorClass =
    dotColor === "green"
      ? "bg-green-400 shadow-[0_1px_3px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.5)]"
      : dotColor === "red"
        ? "bg-red-400 shadow-[0_1px_3px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.5)]"
        : "bg-gray-500 shadow-[0_1px_3px_rgba(15,23,42,0.15)]";
  return (
    <div className="relative flex items-start font-serif text-sm text-gray-500">
      {showConnector && <EventConnector />}
      {isStreaming ? (
        <div className="mt-2 h-1.5 w-1.5 shrink-0 animate-spin rounded-full border border-gray-400 border-t-transparent" />
      ) : (
        <div
          className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dotColorClass}`}
        />
      )}
      <div className="ml-2 min-w-0 flex-1 whitespace-normal break-words">
        {children}
      </div>
    </div>
  );
}

export function ReasoningBlock({
  text,
  isStreaming,
  showConnector,
}: {
  text: string;
  isStreaming: boolean;
  showConnector?: boolean;
}): React.ReactElement {
  const {
    contentRef,
    isContentOpen,
    isExpanded,
    isOverflowing,
    setIsExpanded,
    toggleContent,
  } = useReasoningDisclosure(isStreaming);
  const [thinkingIndex, setThinkingIndex] = useState(0);

  useEffect(() => {
    if (!isStreaming) return;
    const interval = window.setInterval(() => {
      setThinkingIndex((index) => (index + 1) % THINKING_PHRASES.length);
    }, 2000);
    return () => window.clearInterval(interval);
  }, [isStreaming]);

  const isCollapsed = isContentOpen && isOverflowing && !isExpanded;

  return (
    <EventBlock
      showConnector={showConnector}
      isStreaming={isStreaming}
      dotColor="gray"
    >
      <button
        type="button"
        aria-expanded={isContentOpen}
        onClick={toggleContent}
        className="flex items-center font-serif text-sm text-gray-500 transition-colors hover:text-gray-600"
      >
        <span className="font-medium">
          {isStreaming ? THINKING_PHRASES[thinkingIndex] : "Thought process"}
        </span>
        <ChevronDown
          size={10}
          aria-hidden="true"
          className={`relative top-px ml-1 transition-transform duration-200 ${isContentOpen ? "" : "-rotate-90"}`}
        />
      </button>
      {isContentOpen && (
        <div className="mt-2">
          <div
            className={`relative ${isCollapsed ? "overflow-hidden" : ""}`}
            style={
              isCollapsed
                ? { maxHeight: `${REASONING_COLLAPSED_MAX_HEIGHT_REM}rem` }
                : undefined
            }
          >
            <div ref={contentRef}>
              <Markdown className="font-serif text-sm leading-6 text-gray-400 [&_*]:text-gray-400">
                {text}
              </Markdown>
            </div>
            {isCollapsed && (
              <>
                <div className="content-bottom-fade pointer-events-none absolute inset-x-0 bottom-0 h-10" />
                <button
                  type="button"
                  onClick={() => setIsExpanded(true)}
                  className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2 text-gray-400 transition-colors hover:text-gray-600"
                  aria-label="Expand thought process"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </div>
          {isOverflowing && isContentOpen && isExpanded && (
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="mx-auto mt-2 flex text-gray-400 transition-colors hover:text-gray-600"
              aria-label="Minimise thought process"
            >
              <ChevronDown className="h-3.5 w-3.5 rotate-180" />
            </button>
          )}
        </div>
      )}
    </EventBlock>
  );
}

export function DocReadBlock({
  filename,
  isStreaming,
  showConnector,
}: {
  filename?: string;
  isStreaming?: boolean;
  showConnector?: boolean;
}): React.ReactElement {
  return (
    <DocReadBlockUI
      filename={filename}
      isStreaming={isStreaming}
      showConnector={showConnector}
    />
  );
}

export function DocFindBlock({
  filename,
  query,
  totalMatches,
  isStreaming,
  showConnector,
  onClick,
}: {
  filename: string;
  query: string;
  totalMatches: number;
  isStreaming?: boolean;
  showConnector?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  return (
    <DocFindBlockUI
      filename={filename}
      query={query}
      totalMatches={totalMatches}
      isStreaming={isStreaming}
      showConnector={showConnector}
      onClick={onClick}
    />
  );
}
