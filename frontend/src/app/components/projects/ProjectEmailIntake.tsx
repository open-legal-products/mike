"use client";

import { useEffect, useId, useState } from "react";
import type { ProjectEmailPreview, ProjectEmailReceipt } from "@mike/contracts";
import { Modal } from "@/app/components/modals/Modal";
import { FormTextInput, FieldLabel } from "@/app/components/ui/form-field";
import { TABLE_CHECKBOX_CLASS } from "@/app/components/shared/TablePrimitive";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { previewProjectEmail, importProjectEmail, latestProjectEmail, getProjectEmailReceipt, getDocumentFileUrl } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";

export function ProjectEmailIntake({ projectId, folderId, projectName, onClose, onImported }: { projectId: string; folderId: string | null; projectName: string; onClose: () => void; onImported: () => Promise<void> }) {
  const queryId = useId();
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<ProjectEmailPreview | null>(null);
  const [receipt, setReceipt] = useState<ProjectEmailReceipt | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(true);
  const [activity, setActivity] = useState<"preview" | "import" | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const report = (error: unknown) => notifyError(error, { action: "refresh project email", operation: "projects.email-intake" });
  useEffect(() => {
    let active = true;
    void latestProjectEmail(projectId).then(async latest => {
      if (!active || !latest) return;
      setQuery(latest.query);
      const lastReceipt = await getProjectEmailReceipt(projectId, latest.id);
      if (active) { setReceipt(lastReceipt); setSelected(lastReceipt.messages.map(m => m.id)); setConfirmed(true); }
    }).catch(error => { if (active) report(error); }).finally(() => { if (active) { setBusy(false); setLoading(false); } });
    return () => { active = false; };
  }, [projectId]);
  async function search(pageToken?: string) {
    setActivity("preview");
    setBusy(true);
    try {
      const result = await previewProjectEmail(projectId, { query, folderId, pageToken });
      setPreview(result); setSelected([]); setShared(false); setConfirmed(false); setReceipt(null);
    } catch (error) { report(error); }
    finally { setBusy(false); setActivity(null); }
  }
  async function importSelection() {
    const previewId = preview?.id ?? (confirmed ? receipt?.previewId : undefined);
    if (!previewId || !selected.length || (!shared && !confirmed)) return;
    setActivity("import");
    setBusy(true);
    // Once sent, the exact confirmation remains bound even if the response is
    // lost. Retry sends those same IDs rather than starting another batch.
    setConfirmed(true);
    try {
      setReceipt(await importProjectEmail(projectId, previewId, selected));
      await onImported();
    } catch (error) { report(error); }
    finally { setBusy(false); setActivity(null); }
  }
  const retryable = receipt?.messages.some(m => m.items.some(item => item.status === "failed" || item.status === "processing"));
  return <Modal open onClose={() => { if (!busy) onClose(); }} breadcrumbs={["Refresh from Gmail"]} size="lg"
    primaryAction={preview || (receipt && confirmed) ? { label: busy ? (activity === "import" ? "Importing…" : "Loading…") : confirmed ? "Retry confirmed selection" : "Import selected", onClick: () => void importSelection(), disabled: busy || !selected.length || (!shared && !confirmed) || (!!receipt && !retryable) } : undefined}
    cancelAction={{ label: "Close", onClick: onClose, disabled: busy }}>
    <div data-modal-scroll className="min-h-0 flex-1 overflow-y-auto space-y-4 py-4 text-sm text-gray-700">
      <p>New previews import into <strong>{projectName}</strong>{folderId ? " / current folder" : " / project root"}. {confirmed && !preview && "Retrying the restored confirmation keeps its original destination. "}Only messages you select will be imported. This reads Gmail without marking messages read or changing labels.</p>
      <div><FieldLabel htmlFor={queryId}>Gmail query</FieldLabel><FormTextInput id={queryId} value={query} disabled={busy} maxLength={2000} placeholder="from:person@example.com subject:agreement" onChange={e => { setQuery(e.target.value); setPreview(null); setReceipt(null); setConfirmed(false); setSelected([]); setShared(false); }} /></div>
      <PillButtonUI type="button" tone="white" onClick={() => void search()} disabled={busy || !query.trim()}>Preview messages</PillButtonUI>
      {loading && <p role="status">Loading the last confirmed refresh…</p>}
      {busy && !loading && <p role="status">{activity === "import" ? "Importing selected sources; partial results are saved so you can retry safely." : "Reading a bounded Gmail page…"}</p>}
      {preview && <>
        <p className="break-words">Private connection: {preview.accountEmail}. Up to five messages on this page; this is not a complete mailbox scan.</p>
        {!preview.messages.length && <p>No messages on this page.</p>}
        {preview.messages.map(message => <div key={message.id} className="space-y-1 rounded-xl bg-gray-50 p-3">
          <label className="flex items-start gap-2"><input type="checkbox" className={TABLE_CHECKBOX_CLASS} disabled={busy || confirmed || !!message.unavailable} checked={selected.includes(message.id)} onChange={e => setSelected(current => e.target.checked ? [...current, message.id] : current.filter(id => id !== message.id))} /><span className="min-w-0 break-words"><strong>{message.subject || "(no subject)"}</strong><br />{message.from}<br />{message.date}</span></label>
          <p className="whitespace-pre-wrap break-words">{message.unavailable ?? message.excerpt}</p>
          <p>{message.priorOutcome === "imported" ? "Previously imported. Existing or deleted imports will not be recreated." : message.priorOutcome === "incomplete" ? "Previously incomplete. Retry retains completed imports." : message.unavailable ? "Unavailable" : "No previous import found for you from this mailbox into this project."}</p>
          {message.attachments.map((part, i) => <p key={i} className="break-words">{part.name} ({part.size} bytes){part.excluded ? ` — ${part.excluded}` : ""}</p>)}
        </div>)}
        {preview.nextPageToken && !confirmed && <PillButtonUI type="button" tone="white" disabled={busy || selected.length > 0} onClick={() => void search(preview.nextPageToken)}>Next page (clears this page)</PillButtonUI>}
        <label className="flex items-start gap-2"><input type="checkbox" className={TABLE_CHECKBOX_CLASS} checked={shared} disabled={busy || confirmed} onChange={e => setShared(e.target.checked)} /><span>Share the selected messages and supported attachments with everyone who can access this project. My Gmail connection itself stays private.</span></label>
      </>}
      {receipt && <section aria-label="What changed" className="space-y-3"><h2 className="font-medium">What changed — import receipt</h2>
        <p>This reports source imports, not a legal assessment. Unsupported, failed, pending or changed/unverifiable sources are not counted as a complete message. Imported text is untrusted evidence; it cannot authorize actions. Extraction and visual review may still be needed. Native edits can replace imported bytes; save edits as a new version to preserve the original. This intake is not an immutable archive.</p>
        {!receipt.messages.length && <p>No confirmed messages.</p>}
        {receipt.messages.map(message => <div key={message.id} className="space-y-1"><h3 className="break-words font-medium">{message.subject || "(no subject)"} — {message.complete ? "imported" : "incomplete"}</h3>
          <p className="break-words">{message.from}<br />Date as written: {message.date || "not provided"}</p>
          <p className="break-all text-xs">Gmail message {message.id}</p>
          {message.items.map((item, i) => <p key={i} className="break-words">{item.documentId && item.versionId && (item.status === "imported" || item.status === "already_imported") ? <a className="text-blue-600 underline focus-visible:ring-2" href={getDocumentFileUrl(item.documentId, item.versionId)} download>{item.name}</a> : item.name}: {item.status.replaceAll("_", " ")}{item.detail ? ` — ${item.detail}` : ""}</p>)}
        </div>)}
      </section>}
    </div>
  </Modal>;
}
