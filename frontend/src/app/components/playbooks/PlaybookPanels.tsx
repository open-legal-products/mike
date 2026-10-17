"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

const DIVIDER_WIDTH = 6;

/** The IDE's six-pixel panel gap doubles as a mouse, touch, and keyboard handle. */
export function PlaybookPanels({
  sidebar,
  children,
  variant = "sidebar",
  resizeLabel = "Resize rules panel",
}: {
  sidebar: ReactNode;
  children: ReactNode;
  /** The results view puts the adjustable pane to the right of the document. */
  variant?: "sidebar" | "results";
  resizeLabel?: string;
}) {
  const isResults = variant === "results";
  const minWidth = isResults ? 320 : 160;
  const defaultWidth = isResults ? 448 : 320;
  const direction = isResults ? -1 : 1;
  const sidebarId = useId();
  const layoutRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const [preferredWidth, setPreferredWidth] = useState(defaultWidth);
  const maxWidth = layoutWidth
    ? Math.max(minWidth, layoutWidth - 320 - DIVIDER_WIDTH)
    : defaultWidth;
  const width = Math.min(preferredWidth, maxWidth);

  useEffect(() => {
    const layout = layoutRef.current;
    if (!layout || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setLayoutWidth(entry.contentRect.width);
    });
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const stop = () => {
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("blur", stop);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  function resize(next: number) {
    setPreferredWidth(Math.min(maxWidth, Math.max(minWidth, next)));
  }

  function stopDragging() {
    drag.current = null;
    setDragging(false);
  }

  const adjustablePane = (
    <div
      id={sidebarId}
      className="flex min-h-0 min-w-0 flex-col [&>section]:flex-1"
    >
      {sidebar}
    </div>
  );

  return (
    <div
      className={`${isResults ? "@container/run-layout" : "@container"} flex min-h-0 min-w-0 flex-1 flex-col`}
    >
      <div
        ref={layoutRef}
        style={{ "--panel-width": `${width}px` } as CSSProperties}
        className={
          isResults
            ? "grid min-h-0 flex-1 grid-cols-1 gap-1.5 overflow-y-auto @[41rem]/run-layout:grid-cols-[minmax(0,1fr)_6px_var(--panel-width)] @[41rem]/run-layout:gap-0 @[41rem]/run-layout:overflow-hidden"
            : "mx-3 mb-3 grid min-h-0 flex-1 grid-cols-1 gap-1.5 overflow-y-auto p-0.5 md:mx-6.5 @[48rem]:grid-cols-[var(--panel-width)_6px_minmax(0,1fr)] @[48rem]:gap-0 @[48rem]:overflow-hidden"
        }
      >
        {isResults ? children : adjustablePane}
        <div
          role="separator"
          aria-label={resizeLabel}
          aria-orientation="vertical"
          aria-controls={sidebarId}
          aria-valuemin={minWidth}
          aria-valuemax={Math.round(maxWidth)}
          aria-valuenow={Math.round(width)}
          aria-valuetext={`${Math.round(width)} pixels`}
          tabIndex={0}
          title="Drag to resize, or use the left and right arrow keys"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, x: event.clientX };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            const delta = event.clientX - drag.current.x;
            setPreferredWidth((current) =>
              Math.min(
                maxWidth,
                Math.max(
                  minWidth,
                  Math.min(current, maxWidth) + delta * direction,
                ),
              ),
            );
            drag.current.x = event.clientX;
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            stopDragging();
          }}
          onPointerCancel={stopDragging}
          onLostPointerCapture={stopDragging}
          onKeyDown={(event) => {
            const next = {
              ArrowLeft: width - 24 * direction,
              ArrowRight: width + 24 * direction,
              Home: minWidth,
              End: maxWidth,
            }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            resize(next);
          }}
          className={`group relative z-10 hidden touch-none cursor-col-resize focus-visible:outline-none ${isResults ? "@[41rem]/run-layout:block" : "@[48rem]:block"}`}
        >
          <div className="absolute inset-y-0 -left-1 -right-1" />
          <div
            className={`pointer-events-none absolute inset-y-2 left-0.5 w-0.5 rounded-full transition-colors group-focus-visible:bg-blue-600 ${dragging ? "bg-blue-600" : "group-hover:bg-blue-600/60"}`}
          />
        </div>
        {isResults ? adjustablePane : children}
      </div>
    </div>
  );
}
