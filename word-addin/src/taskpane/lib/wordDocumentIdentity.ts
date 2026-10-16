/// <reference types="office-js" />
import { useEffect, useState } from "react";
import { createSecureUuid } from "./secureUuid";
import { clearWordEditAnchorRegistry } from "./wordEditAnchors";
import { userMessage } from "./notify";

const WORD_DOCUMENT_ID_SETTING = "mike.word.documentId.v1";
const WORD_DOCUMENT_URL_SETTING = "mike.word.documentUrl.v1";

function saveSettings(settings: Office.Settings): Promise<void> {
  return new Promise((resolve, reject) => {
    settings.saveAsync((result) => {
      if (result.status === Office.AsyncResultStatus.Succeeded) resolve();
      else reject(new Error(result.error?.message || "Could not save the document ID."));
    });
  });
}

/**
 * Comparison key for document URLs. Trim, drop trailing slashes, and compare
 * case-insensitively so trivial host/path casing differences never produce a
 * false "copy" verdict. Deliberately NOT full SharePoint canonicalization —
 * a missed copy is recoverable, an orphaned chat history is not.
 */
function normalizeDocumentUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string") return "";
  return rawUrl.trim().replace(/\/+$/, "").toLowerCase();
}

function readCurrentDocumentUrl(): string {
  try {
    return normalizeDocumentUrl(Office.context.document.url);
  } catch {
    // Some hosts throw instead of returning "" for unsaved documents; treat
    // that the same as "no URL available" and keep the stored identity.
    return "";
  }
}

export function readCurrentDocumentName(): string {
  try {
    const rawUrl = Office.context.document.url;
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return "Word document";
    const withoutQuery = rawUrl.trim().split(/[?#]/, 1)[0] ?? "";
    const segment = withoutQuery.split(/[\\/]/).filter(Boolean).at(-1);
    return segment ? decodeURIComponent(segment) : "Word document";
  } catch {
    return "Word document";
  }
}

/**
 * The identity UUID lives in Office document settings, which are embedded in
 * the .docx — so "Save As"/file-copy carries it into the copy, silently
 * pointing the copy at the ORIGINAL document's chat history and edit anchors.
 * Storing the document URL alongside the UUID lets us detect that: when both
 * the stored and current URLs are known and differ, the file is a copy and
 * gets a fresh identity. If either URL is empty (unsaved doc, host quirk) we
 * conservatively keep the existing identity.
 */
async function getOrCreateWordDocumentId(): Promise<string> {
  const settings = Office.context.document.settings;
  const currentUrl = readCurrentDocumentUrl();
  const existing = settings.get(WORD_DOCUMENT_ID_SETTING);
  const storedUrl = normalizeDocumentUrl(settings.get(WORD_DOCUMENT_URL_SETTING));

  if (typeof existing === "string" && existing.trim()) {
    const isCopy = storedUrl !== "" && currentUrl !== "" && storedUrl !== currentUrl;
    if (!isCopy) {
      if (currentUrl !== "" && storedUrl !== currentUrl) {
        // Adopt the URL: identity predates URL tracking, or an unsaved
        // document just gained its first save location.
        settings.set(WORD_DOCUMENT_URL_SETTING, currentUrl);
        await saveSettings(settings);
      }
      return existing;
    }

    // Copy detected: mint a fresh identity so the copy does not inherit the
    // original's chat history, and drop the stale edit-anchor registry (its
    // entries reference the original document's messages).
    const documentId = createSecureUuid();
    settings.set(WORD_DOCUMENT_ID_SETTING, documentId);
    settings.set(WORD_DOCUMENT_URL_SETTING, currentUrl);
    clearWordEditAnchorRegistry(settings);
    await saveSettings(settings);
    return documentId;
  }

  const documentId = createSecureUuid();
  settings.set(WORD_DOCUMENT_ID_SETTING, documentId);
  if (currentUrl !== "") settings.set(WORD_DOCUMENT_URL_SETTING, currentUrl);
  await saveSettings(settings);
  return documentId;
}

export function useWordDocumentIdentity(): {
  documentId: string | null;
  loading: boolean;
  error: string | null;
} {
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getOrCreateWordDocumentId()
      .then((id) => {
        if (!cancelled) setDocumentId(id);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(
            userMessage(reason, {
              fallback: "Could not identify this Word document.",
            })
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { documentId, loading, error };
}
