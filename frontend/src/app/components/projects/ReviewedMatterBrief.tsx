"use client";
import { useEffect, useState } from "react";
import type { MatterBriefContent, MatterBriefProposal, MatterBriefState, BriefSourceIdentity } from "@mike/contracts";
import { Modal } from "@/app/components/modals/Modal";
import { FormTextInput } from "@/app/components/ui/form-field";
import { TABLE_CHECKBOX_CLASS } from "@/app/components/shared/TablePrimitive";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { getMatterBrief, designateMatterBrief, proposeMatterBrief, getMatterBriefProposal, applyMatterBrief, matterBriefSourceUrl } from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
const titles = { position: "Current position", awaiting: "Awaiting whom", uncertainties: "Material uncertainties", nextAction: "Next action" };
function BriefContent({ content, evidence, projectId }: {
    content: MatterBriefContent;
    evidence?: BriefSourceIdentity[];
    projectId: string;
}) {
    return <>{Object.entries(titles).map(([key, title]) => <section key={key} className="space-y-2"><h3 className="font-medium">{title}</h3>
        {content[key as keyof MatterBriefContent].map((row, i) => <div key={i} className="space-y-1 text-sm"><p>{row.text}</p><p className="text-xs text-gray-500">{row.status.replaceAll("_", " ")}</p>
            {row.citations.map((c, j) => <blockquote key={j} className="pl-3 text-xs text-gray-600"><p>“{c.quote}”</p>{evidence?.[c.source] && <a className="underline focus-visible:ring-2" href={matterBriefSourceUrl(projectId, evidence[c.source])} target="_blank" rel="noopener noreferrer">{evidence[c.source].filename} — checked source revision</a>}</blockquote>)}</div>)}
        {!content[key as keyof MatterBriefContent].length && <p className="text-sm text-gray-500">No proposed entry.</p>}
    </section>)}</>;
}
export function ReviewedMatterBrief({ projectId, onApplied }: {
    projectId: string;
    onApplied?: () => Promise<void>;
}) {
    const [open, setOpen] = useState(false), [state, setState] = useState<MatterBriefState | null>(null);
    const [proposal, setProposal] = useState<MatterBriefProposal | null>(null), [selected, setSelected] = useState<string[]>([]);
    const [target, setTarget] = useState(""), [model, setModel] = useState("");
    const [confirm, setConfirm] = useState(false), [provider, setProvider] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
    async function load() { const next = await getMatterBrief(projectId); setState(next); return next; }
    function report(error: unknown) { notifyError(error, { operation: "project_brief.ui" }); }
    function close() { if (!busy) setOpen(false); }
    useEffect(() => {
        if (!open)
            return;
        let live = true;
        setBusy(true);
        setState(null);
        setProposal(null);
        setConfirm(false);
        setProvider(false);
        setNotice("");
        setSelected([]);
        getMatterBrief(projectId).then(async (next) => {
            if (!live)
                return;
            setState(next);
            if (next.pendingProposalId) {
                const q = await getMatterBriefProposal(projectId, next.pendingProposalId);
                if (live)
                    setProposal(q);
            }
        }).catch(error => { if (live)
            report(error); }).finally(() => { if (live)
            setBusy(false); });
        return () => { live = false; };
    }, [open, projectId]);
    async function act(action: () => Promise<void>) { setBusy(true); setNotice(""); try {
        await action();
    }
    catch (error) {
        report(error);
    }
    finally {
        setBusy(false);
    } }
    async function applyReviewedUpdate() {
        if (!proposal) return;
        await applyMatterBrief(projectId, proposal.id);
        setProposal(null);
        setConfirm(false);
        setSelected([]);
        setNotice("Applied. A new brief version and the source-review checkpoint were saved together.");
        try {
            await load();
            await onApplied?.();
        } catch (error) {
            report(error);
            setNotice("Applied. The brief was saved, but the document list could not refresh. Reload the project to see its current version.");
        }
    }
    const unreviewed = state?.sources.filter(s => !s.reviewed) ?? [];
    const includedSourceIds = new Set(proposal?.sources.map(s => s.documentId));
    return <>
        <TextButtonUI onClick={() => setOpen(true)}>Resume matter</TextButtonUI>
        <Modal open={open} onClose={close} breadcrumbs={["Reviewed matter brief"]} size="xl" cancelAction={{ label: "Close", onClick: close, disabled: busy }}>
            <div data-modal-scroll className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6 text-gray-800 [overflow-wrap:anywhere]">
                <p className="text-sm text-gray-600">An internal, project-visible brief. Imported documents are not automatically read or reviewed. Source statements and dates are not verified legal obligations.</p>
                {busy && <p role="status">Working…</p>}{notice && <p role="status">{notice}</p>}
                {!busy && !state && <PillButtonUI tone="black" onClick={() => void act(async () => { await load(); })}>Retry loading brief</PillButtonUI>}
                {state && !state.brief && <section className="space-y-3"><h2 className="font-serif text-xl">Choose the project’s brief</h2><p className="text-sm">Upload a DOCX first, then designate it here. Existing document permissions and version history apply.</p>
                    <label className="block text-sm">Brief document<select className="mt-1 block w-full rounded-lg p-2 focus-visible:ring-2" value={target} onChange={e => setTarget(e.target.value)} disabled={!state.canEdit || busy}><option value="">Select a DOCX</option>{state.sources.map(s => <option key={s.documentId} value={s.documentId}>{s.filename}</option>)}</select></label>
                    <label className="flex gap-2 text-sm"><input type="checkbox" className={TABLE_CHECKBOX_CLASS} checked={confirm} onChange={e => setConfirm(e.target.checked)}/>I understand updates to this brief will be visible to people with project access.</label>
                    <PillButtonUI tone="black" disabled={!state.canEdit || !target || !confirm || busy} onClick={() => void act(async () => { await designateMatterBrief(projectId, target); await load(); setConfirm(false); })}>Designate brief</PillButtonUI>
                </section>}
                {state?.brief && <>
                    <section className="space-y-2"><h2 className="font-serif text-xl">Resume this matter</h2><a className="text-sm underline focus-visible:ring-2" href={matterBriefSourceUrl(projectId, state.brief)} target="_blank" rel="noopener noreferrer">Open current brief: {state.brief.filename}</a>
                        {state.manualChanges && <p role="alert" className="text-sm">The brief was edited after the last accepted update. Those edits have not inherited its review checkpoint. Read the current version before proposing an update.</p>}
                        <p className="text-sm text-gray-500">{state.acceptedAt ? `Last accepted update: ${new Date(state.acceptedAt).toLocaleString()}` : "No update has been accepted here yet."}</p>
                        {state.acceptedContent && <details><summary className="cursor-pointer text-sm">Last accepted position {state.manualChanges ? "(historical)" : ""}</summary><div className="mt-3 space-y-4"><BriefContent content={state.acceptedContent} evidence={state.acceptedEvidence} projectId={projectId}/></div></details>}
                    </section>
                    <section className="space-y-3"><h2 className="font-medium">Outstanding sources ({unreviewed.length})</h2><p className="text-sm text-gray-600">Select up to ten. Unreadable or incomplete extraction stays outstanding. This inventory does not prove the matter file is complete.</p>
                        {state.sources.map(s => <label key={s.documentId} className="flex items-start gap-2 text-sm"><input type="checkbox" className={TABLE_CHECKBOX_CLASS} disabled={busy || !state.canEdit || !!proposal || selected.length >= 10 && !selected.includes(s.documentId)} checked={proposal ? includedSourceIds.has(s.documentId) : selected.includes(s.documentId)} onChange={e => setSelected(ids => e.target.checked ? [...ids, s.documentId] : ids.filter(id => id !== s.documentId))}/><span>{s.filename}
                            {proposal && <span className="block text-xs text-gray-500">{includedSourceIds.has(s.documentId) ? "Included in this proposal — review the listed revision below." : "Not included in this proposal."}</span>}
                            <span className="block text-xs text-gray-500">{s.reviewed ? "Reviewed revision" : s.ready ? "Not reviewed" : s.reason ?? "Not readable"}</span></span></label>)}
                        {!state.sources.length && <p className="text-sm">No source documents in this project yet.</p>}
                    </section>
                    {state.canEdit && !proposal && <section className="space-y-3"><label className="block text-sm">Configured model ID<FormTextInput value={model} onChange={e => setModel(e.target.value)} placeholder="Choose a model configured for this workspace" disabled={busy}/></label>
                        <label className="flex gap-2 text-sm"><input type="checkbox" className={TABLE_CHECKBOX_CLASS} checked={provider} onChange={e => setProvider(e.target.checked)}/>Send only the current brief and selected source text to this model’s configured provider. Provider charges may apply.</label>
                        <PillButtonUI tone="black" disabled={busy || !selected.length || !model.trim() || !provider} onClick={() => void act(async () => { setProposal(await proposeMatterBrief(projectId, selected, model.trim())); setConfirm(false); })}>Prepare proposed update</PillButtonUI>
                    </section>}
                </>}
                {proposal && <section className="space-y-4"><h2 className="font-serif text-xl">Proposed update — not applied</h2><p className="text-sm">Review every statement and quote. The model cannot approve a decision or verify an obligation. Exact quote matching does not establish that a summary is correct.</p>
                    <p className="text-sm"><a className="underline focus-visible:ring-2" href={matterBriefSourceUrl(projectId, proposal.base)} target="_blank" rel="noopener noreferrer">{proposal.base.filename} — proposal base revision</a></p>
                    <section aria-label="Included source revisions" className="space-y-2">
                        <h3 className="font-medium">Included source revisions ({proposal.sources.length})</h3>
                        <p className="text-sm text-gray-600">Review every revision below, including sources with no quoted statement. Applying this proposal records all of these source revisions as reviewed. Other inventory documents stay outside this proposal.</p>
                        <ul className="space-y-2 text-sm">{proposal.sources.map(s => <li key={s.documentId}><a className="underline focus-visible:ring-2" href={matterBriefSourceUrl(projectId, s)} target="_blank" rel="noopener noreferrer">{s.filename} — included source revision</a></li>)}</ul>
                    </section>
                    <details><summary className="cursor-pointer text-sm">Before: source text of the brief</summary><pre className="mt-2 whitespace-pre-wrap text-xs">{proposal.before}</pre></details>
                    <div className="space-y-4"><BriefContent content={proposal.content} evidence={[proposal.base, ...proposal.sources]} projectId={projectId}/></div>
                    <h3 className="font-medium">Sources still outstanding</h3>{proposal.gaps.map(g => <p key={g.documentId} className="text-sm">{g.filename}: {g.reason}</p>)}{!proposal.gaps.length && <p className="text-sm">None in the captured inventory; this does not certify completeness.</p>}
                    <p className="text-sm">Visually check signatures and execution pages in the originals; text extraction may not capture them.</p>
                    <label className="flex gap-2 text-sm"><input type="checkbox" className={TABLE_CHECKBOX_CLASS} checked={confirm} disabled={busy || !state?.canEdit} onChange={e => setConfirm(e.target.checked)}/>I reviewed this proposed text, the base brief revision and every included source revision listed above. Apply the exact proposal as a new project-visible brief version.</label>
                    <PillButtonUI tone="black" disabled={!state?.canEdit || !confirm || busy} onClick={() => void act(applyReviewedUpdate)}>Apply reviewed update</PillButtonUI>
                    <TextButtonUI disabled={busy} onClick={() => { setProposal(null); setConfirm(false); }}>Prepare a different proposal</TextButtonUI>
                </section>}
            </div>
        </Modal>
    </>;
}
