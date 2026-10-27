import { useCallback, useEffect, useState } from "react";
import { getDocumentFile } from "../api/client";
import { userMessage } from "../lib/notify";

// A visual's version never changes once written, so a document fetched once
// is good for the life of the pane.
const htmlByVersion = new Map<string, string>();

interface VisualDocumentState {
  key: string;
  html: string | null;
  error: string | null;
}

function cacheKey(documentId: string, versionId?: string): string {
  return `${documentId}:${versionId ?? ""}`;
}

export function useVisualDocument(
  documentId: string,
  versionId?: string,
): {
  html: string | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const key = cacheKey(documentId, versionId);
  const [state, setState] = useState<VisualDocumentState>(() => ({
    key,
    html: htmlByVersion.get(key) ?? null,
    error: null,
  }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const cached = htmlByVersion.get(key);
    if (cached !== undefined) {
      setState({ key, html: cached, error: null });
      return;
    }
    let cancelled = false;
    setState({ key, html: null, error: null });
    getDocumentFile(documentId, versionId).then(
      (html) => {
        htmlByVersion.set(key, html);
        if (!cancelled) setState({ key, html, error: null });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            key,
            html: null,
            error: userMessage(error, { action: "load the visual" }),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [documentId, key, versionId, attempt]);

  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  const current = state.key === key ? state : null;
  return {
    html: current?.html ?? null,
    loading: !current || (current.html === null && current.error === null),
    error: current?.error ?? null,
    retry,
  };
}
