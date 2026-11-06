"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { LIQUID_GLASS_FLAT_CLASS } from "./LiquidGlassUI";
import { TextButtonUI } from "./TextButtonUI";

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
      className={`min-w-0 overflow-hidden rounded-xl ${LIQUID_GLASS_FLAT_CLASS}`}
    >
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <h3 className="min-w-0 font-serif text-base font-medium text-gray-800 [overflow-wrap:anywhere]">
          {title}
        </h3>
        <TextButtonUI
          size="icon-xs"
          className="-mr-1.5 h-6 text-gray-800 hover:text-gray-950"
          onClick={() => void copy()}
          aria-label={copied ? `Copied ${title}` : `Copy ${title}`}
          title={copied ? "Copied" : "Copy"}
        >
          {copied ? (
            <Check aria-hidden="true" className="h-3 w-3 text-green-600" />
          ) : (
            <Copy aria-hidden="true" className="h-3 w-3" />
          )}
        </TextButtonUI>
      </div>
      <div
        tabIndex={0}
        className="max-h-96 select-text overflow-y-auto whitespace-pre-wrap px-3 py-3 font-sans text-xs leading-relaxed [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
      >
        {text}
      </div>
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
      {copyError && (
        <p role="alert" className="px-3 pb-3 text-xs text-gray-600">
          Couldn’t copy. Select the text and copy it manually.
        </p>
      )}
    </section>
  );
}
