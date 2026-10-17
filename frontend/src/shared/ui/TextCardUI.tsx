"use client";

import { useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";
import { LIQUID_GLASS_FLAT_CLASS } from "./LiquidGlassUI";
import { PillButtonUI } from "./PillButtonUI";
import { TextSlabUI } from "./TextSlabUI";

/** Literal copy-ready text; never interpret markup as HTML or Markdown. */
export function TextCardUI({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }

  return (
    <section
      aria-label={title}
      className={`min-w-0 rounded-xl p-3 ${LIQUID_GLASS_FLAT_CLASS}`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-sm font-medium text-gray-800 [overflow-wrap:anywhere]">
          {title}
        </h3>
        <PillButtonUI
          tone="white"
          size="xs"
          className="shrink-0"
          onClick={() => void copy()}
          aria-label={copied ? `Copied ${title}` : `Copy ${title}`}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </PillButtonUI>
      </div>
      <TextSlabUI
        tabIndex={0}
        className="max-h-96 select-text overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
      >
        {text}
      </TextSlabUI>
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
      {copyError && (
        <p role="alert" className="mt-2 text-xs text-gray-600">
          Couldn’t copy. Select the text and copy it manually.
        </p>
      )}
    </section>
  );
}
