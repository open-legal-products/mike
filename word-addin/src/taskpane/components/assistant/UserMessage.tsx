import React, { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FileText, Waypoints } from "lucide-react";

const COLLAPSED_CONTENT_HEIGHT = 144;

/**
 * Right-aligned user bubble, duplicated from the web app's UserMessage
 * including the same file/workflow chips used by the frontend assistant.
 * Memoized: user turns never change while an answer streams below them.
 */
function UserMessageImpl({
  content,
  files,
  workflow,
}: {
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
}): React.ReactElement {
  const contentRef = useRef<HTMLParagraphElement>(null);
  const [canExpand, setCanExpand] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    setExpanded(false);
    let frame: number | null = null;
    const measure = (): void => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        const overflows = element.scrollHeight > COLLAPSED_CONTENT_HEIGHT + 1;
        setCanExpand((current) =>
          current === overflows ? current : overflows,
        );
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [content]);

  return (
    <div className="w-full flex justify-end">
      <div className="max-w-[80%] bg-gray-100 rounded-xl px-4 py-3">
        <div
          className="relative overflow-hidden"
          // Clamped from the very first frame (maxHeight is inert for short
          // content): the height painted on send is final, and ChatView's
          // pre-paint spacer measurement sees the same clamped box. Only the
          // gradient/expand affordances wait for the post-paint overflow
          // measurement — they don't change the box height.
          style={expanded ? undefined : { maxHeight: COLLAPSED_CONTENT_HEIGHT }}
          data-testid="user-message-content"
        >
          <p
            ref={contentRef}
            className={`text-sm text-gray-900 whitespace-pre-wrap break-words ${
              canExpand ? "pb-8" : ""
            }`}
          >
            {content}
          </p>
          {canExpand && !expanded && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-transparent via-gray-100/80 to-gray-100 backdrop-blur-[2px] [mask-image:linear-gradient(to_bottom,transparent,black_55%)]"
            />
          )}
          {canExpand && (
            <button
              type="button"
              aria-label={
                expanded ? "Collapse user message" : "Expand user message"
              }
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
              className="absolute bottom-0 left-1/2 z-10 inline-flex h-7 w-9 -translate-x-1/2 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-200/90 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
              {expanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          )}
        </div>
        {(workflow || (files && files.length > 0)) && (
          <div className="mt-3 flex flex-wrap justify-end gap-1.5">
            {workflow && (
              <div className="inline-flex items-center gap-1 rounded-full border border-blue-600 bg-blue-600 py-0.5 pl-2 pr-2.5 text-xs text-white shadow">
                <Waypoints className="h-2.5 w-2.5 shrink-0" />
                <span className="max-w-[140px] truncate">{workflow.title}</span>
              </div>
            )}
            {files?.map((file) => (
              <div
                key={`${file.document_id ?? file.filename}-${file.filename}`}
                className="inline-flex items-center gap-1 rounded-[10px] border border-white/70 bg-white py-0.5 pl-2 pr-2.5 text-xs text-gray-800 shadow-sm"
              >
                <FileText className="h-2.5 w-2.5 shrink-0 text-gray-400" />
                <span className="max-w-[140px] truncate">{file.filename}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const UserMessage = React.memo(UserMessageImpl);
