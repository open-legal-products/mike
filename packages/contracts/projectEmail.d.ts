export type ProjectEmailMessage = {
  id: string; subject: string; from: string; date: string; excerpt: string;
  attachments: Array<{ name: string; size: number; excluded?: string }>;
  unavailable?: string; bodyUnavailable?: string;
  priorOutcome?: "imported" | "incomplete";
};
export type ProjectEmailPreview = {
  id: string; projectId: string; accountEmail: string; query: string;
  expiresAt: string; messages: ProjectEmailMessage[];
  nextPageToken?: string;
};
export type ProjectEmailReceipt = {
  previewId: string; query: string;
  messages: Array<{ id: string; subject: string; from: string; date: string; complete: boolean;
    /**
     * True when this confirmation cannot import more for this message; it remains incomplete and requires fresh preview and consent.
     * Existing item receipts remain intact. Omitted for unblocked and legacy receipts.
     */
    requiresPreview?: boolean;
    items: Array<{
    name: string; status: "imported" | "already_imported" | "processing" | "excluded" | "failed" | "deleted" | "source_changed" | "source_unverified";
    documentId?: string; versionId?: string; sha256?: string; detail?: string;
  }> }>;
};

export type ProjectEmailLatest = { id: string; query: string; confirmed_at: string };
