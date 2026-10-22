"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { API_BASE } from "@/app/lib/mikeApi";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import type { CitationQuote } from "../types";
import { highlightQuote } from "./highlightQuote";
import { viewRoundingClass, type ViewRounding } from "./viewRounding";

interface Props {
  doc: { document_id: string; version_id?: string | null } | null;
  displayUrl?: string | null;
  refetchKey?: number | string;
  quotes?: CitationQuote[];
  quoteFocusKey?: string | number;
  quote?: string;
  rounded?: ViewRounding;
}

/** Read-only UTF-8 view: untrusted Markdown is rendered as text, never HTML. */
export function TextView({ doc, displayUrl, refetchKey, quotes, quoteFocusKey, quote, rounded = true }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const pre = useRef<HTMLPreElement>(null);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const documentId = doc?.document_id;
  const versionId = doc?.version_id;

  useEffect(() => {
    const url = displayUrl ?? (documentId
      ? `${API_BASE}/single-documents/${encodeURIComponent(documentId)}/display${versionId ? `?version_id=${encodeURIComponent(versionId)}` : ""}`
      : null);
    if (!url) { setText(null); setError("No document selected."); setLoading(false); return; }
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError(null); setText(null);
    void (async () => {
      try {
        const response = await authenticatedFetch(url, { credentials: "include", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!["text/plain", "text/markdown", "text/x-markdown"].includes(type)) throw new Error("Unexpected text document MIME type");
        const raw = await response.arrayBuffer();
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^\uFEFF/, "");
        if (active) setText(decoded);
      } catch (cause) {
        if (!active) return;
        setError(describeError(cause, { action: "load this text document", fallback: "Could not display this document." }).message);
        notifyError(cause, { action: "load this text document", onRetry: retry });
      } finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [displayUrl, documentId, versionId, refetchKey, attempt, retry]);

  const activeQuote = quotes?.find((item) => item.quote.trim())?.quote ?? quote;
  useEffect(() => {
    const el = pre.current;
    if (!el || text === null) return;
    el.textContent = text;
    el.removeAttribute("data-original-text");
    if (!activeQuote?.trim()) return;
    let active = true;
    void highlightQuote([el], activeQuote).then((found) => {
      if (active && found) el.querySelector<HTMLElement>(".pdf-text-highlight")?.scrollIntoView?.({ block: "center" });
    });
    return () => { active = false; };
  }, [text, activeQuote, quoteFocusKey]);

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-surface ${viewRoundingClass(rounded)}`}>
      {loading ? <div role="status" aria-label="Loading text document" className="flex flex-col gap-3 p-5">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-app-surface-active" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-app-surface-active" />
      </div> : error ? <div role="alert" className="flex flex-col gap-3 p-5 text-sm">
        <p>{error}</p>
        {(documentId || displayUrl) && <button type="button" onClick={retry} className="self-start rounded-md px-3 py-2 font-medium text-blue-600 focus-visible:outline-2 focus-visible:outline-offset-2">Retry</button>}
      </div> : <div aria-label="Text document" className="min-h-0 flex-1 overflow-auto p-5">
        <pre ref={pre} className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-foreground">{text}</pre>
      </div>}
    </div>
  );
}
