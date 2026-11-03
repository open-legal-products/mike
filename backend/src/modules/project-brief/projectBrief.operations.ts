import { randomUUID } from "node:crypto";
import { Document, Packer, Paragraph, TextRun } from "docx";
import type { MatterBriefContent, MatterBriefProposal, MatterBriefState } from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { downloadFile, uploadFile, versionStorageKey } from "../../lib/storage";
import { contentSha256 } from "../../lib/documentVersions";
import { completeText } from "../../lib/llm";
import { resolveEffectiveChatModel } from "../../lib/modelSelection";
import { getEffectiveApiKeys } from "../user/user.service";
import { applyReviewedBrief } from "../documents/documents.service";
import { hashText, publicIdentity, contentSchema, proposalSystemPrompt, sections, generateValidatedContent, sourceExcerpts, resolveExcerptContent, type Evidence } from "./projectBrief.content";
type Actor = {
    projectId: string;
    userId: string;
    userEmail?: string;
};
type Snapshot = Omit<Evidence, "text"> & {
    ready: boolean;
    reason: string | null;
    reviewed?: boolean;
    fileType: string;
    sizeBytes: number | null;
    text?: string | null;
};
type Bundle = {
    designationId: string | null;
    pendingProposalId: string | null;
    brief: Snapshot | null;
    accepted: Snapshot | null;
    acceptedContent: MatterBriefContent | null;
    acceptedEvidence: Snapshot[];
    acceptedAt: string | null;
    canEdit: boolean;
    sources: Snapshot[];
};
type StoredBriefProposal = {
    id: string;
    base: Snapshot;
    sources: Snapshot[];
    content: MatterBriefContent;
    before_text: string;
    gaps: MatterBriefProposal["gaps"];
    expires_at: string;
    applied_version_id: string | null;
    applied_at: string | null;
};
const args = (a: Actor) => ({ p_project_id: a.projectId, p_actor_id: a.userId, p_actor_email: a.userEmail ?? "" });
function dbFailure(error: {
    code?: string;
}) {
    if (error.code === "P0002")
        return failure("not_found", "The project or proposal is unavailable.");
    if (error.code === "42501")
        return failure("forbidden", "Editing this project is not permitted.");
    if (error.code === "PB002")
        return failure("conflict", "This project already has a live designated brief. Use the existing document; another can be designated only after that brief is moved, archived or deleted.");
    if (error.code === "PB001")
        return failure("conflict", "The brief or a source changed. Refresh and prepare a new proposal.");
    if (error.code === "22023")
        return failure("validation", "Select an existing DOCX brief in a project of at most 500 documents.");
    return internalFailure(error);
}
async function bundle(db: Db, a: Actor, ids: string[] = []): Promise<ServiceResult<Bundle>> {
    const { data, error } = await db.rpc("project_brief_bundle", { ...args(a), p_selected: ids });
    return error ? dbFailure(error) : ok(data as Bundle);
}
function sameBytes(a: Snapshot | null, b: Snapshot | null): boolean {
    return !!a && !!b && ["documentId", "versionId", "hash", "revision", "storagePath"].every(k => a[k as keyof Snapshot] === b[k as keyof Snapshot]);
}
export async function resumeBrief(db: Db, a: Actor): Promise<ServiceResult<MatterBriefState>> {
    const result = await bundle(db, a);
    if (!result.ok)
        return result;
    const b = result.data;
    return ok({ pendingProposalId: b.pendingProposalId, brief: b.brief ? identity(b.brief) : null, acceptedVersionId: b.accepted?.versionId ?? null,
        acceptedAt: b.acceptedAt, acceptedContent: b.acceptedContent, acceptedEvidence: (b.acceptedEvidence ?? []).map(identity),
        manualChanges: !!b.accepted && !sameBytes(b.brief, b.accepted), canEdit: b.canEdit,
        sources: b.sources.filter(s => s.documentId !== b.brief?.documentId).map(s => ({ ...identity(s), ready: s.ready, reason: s.reason, reviewed: s.reviewed === true })),
    });
}
function identity(s: Snapshot) { return publicIdentity({ ...s, text: s.text ?? "" }); }
export async function designateBrief(db: Db, a: Actor, documentId: string): Promise<ServiceResult<null>> {
    const { error } = await db.rpc("project_brief_designate", { ...args(a), p_document_id: documentId });
    return error ? dbFailure(error) : ok(null);
}
export type BriefGenerator = (input: {
    before: string;
    evidence: Evidence[];
    model: string;
    repair?: true;
}) => Promise<unknown>;
function stripText(s: Snapshot) { const { text: _text, reviewed: _reviewed, ...snapshot } = s; return snapshot; }
function toProposal(q: StoredBriefProposal): MatterBriefProposal {
    return { id: q.id, base: identity(q.base), sources: q.sources.map(identity), content: q.content,
        before: q.before_text, gaps: q.gaps, expiresAt: q.expires_at, appliedVersionId: q.applied_version_id };
}
function renderProposalDocx({ content, evidence, gaps }: {
    content: MatterBriefContent;
    evidence: Evidence[];
    gaps: MatterBriefProposal["gaps"];
}) {
    const paragraphs: Paragraph[] = [new Paragraph({ text: "Matter brief — internal human-reviewed update", heading: "Title" }),
        new Paragraph("Acceptance records a review of the listed source revisions; it does not certify legal conclusions or deadlines."),
        new Paragraph("Visually check signatures and execution pages in the originals; text extraction may not capture them.")];
    for (const [key, title] of Object.entries(sections)) {
        paragraphs.push(new Paragraph({ text: title, heading: "Heading1" }));
        for (const row of content[key as keyof MatterBriefContent]) {
            paragraphs.push(new Paragraph({ children: [new TextRun({ text: `[${row.status}] `, italics: true }), new TextRun(row.text)] }));
            for (const c of row.citations) {
                const s = evidence[c.source];
                paragraphs.push(new Paragraph(`${s.filename} · document ${s.documentId} · version ${s.versionId} · SHA-256 ${s.hash}: “${c.quote}”`));
            }
        }
    }
    paragraphs.push(new Paragraph({ text: "Outstanding sources", heading: "Heading1" }));
    if (gaps.length) for (const gap of gaps) paragraphs.push(new Paragraph(`${gap.filename}: ${gap.reason}`));
    else paragraphs.push(new Paragraph("No outstanding sources in the current project inventory. This does not establish that the file is complete."));
    return Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }));
}
/** Only server-loaded evidence enters the adapter. No user memory or chat context. */
export async function proposeBrief(db: Db, a: Actor, input: {
    sourceIds: string[];
    model: string;
}, generator?: BriefGenerator): Promise<ServiceResult<MatterBriefProposal>> {
    const ids = [...new Set(input.sourceIds)];
    if (!ids.length || ids.length > 10)
        return failure("validation", "Select between one and ten source documents.");
    const result = await bundle(db, a, ids);
    if (!result.ok)
        return result;
    const b = result.data;
    const designationId = b.designationId;
    if (!b.canEdit)
        return failure("forbidden", "Editing this project is not permitted.");
    if (!b.brief?.ready)
        return failure("conflict", "The designated brief needs complete, current text extraction first.");
    const selected = b.sources.filter(s => ids.includes(s.documentId) && s.documentId !== b.brief!.documentId);
    if (selected.length !== ids.length)
        return failure("validation", "Select project sources other than the brief.");
    const readable = selected.filter(s => s.ready && typeof s.text === "string");
    if (!readable.length)
        return failure("conflict", "No selected source has complete, current extracted text. Outstanding sources remain unreviewed.");
    const snapshots = [b.sources.find(s => s.documentId === b.brief!.documentId)!, ...readable];
    if (snapshots.some(s => !s.text || hashText(s.text) !== s.textHash || !s.hash || !s.sizeBytes || s.sizeBytes > 20000000)
        || snapshots.reduce((n, s) => n + (s.text?.length ?? 0), 0) > 200000
        || snapshots.reduce((n, s) => n + (s.sizeBytes ?? 0), 0) > 30000000)
        return failure("validation", "The selected evidence exceeds this review's size limits or has stale extraction.");
    for (const s of snapshots) {
        const bytes = await downloadFile(s.storagePath);
        if (!bytes || contentSha256(bytes) !== s.hash)
            return failure("conflict", "A source's stored bytes changed or are unavailable. Refresh before proposing.");
    }
    const evidence = snapshots.map(s => ({ ...s, text: s.text! })) as Evidence[];
    let generate = generator;
    let resolve: ((value: unknown, evidence: Evidence[]) => unknown) | undefined;
    if (!generate) {
        try {
            const { data: project, error } = await db.from("projects").select("org_id").eq("id", a.projectId).single();
            if (error)
                return internalFailure(error);
            const apiKeys = await getEffectiveApiKeys(a.userId, project.org_id, db);
            const resolution = await resolveEffectiveChatModel({ requested: input.model, apiKeys, userId: a.userId, db, orgId: project.org_id });
            if (!resolution.ok)
                return failure("validation", resolution.detail);
            const generationSignal = AbortSignal.timeout(120000);
            resolve = resolveExcerptContent;
            generate = async (packet) => completeText({ model: resolution.model, apiKeys,
                systemPrompt: proposalSystemPrompt, user: JSON.stringify({
                    priorBriefContext: { filename: packet.evidence[0].filename, text: packet.before },
                    evidence: packet.evidence.slice(1).map((s, index) => ({ index: index + 1, filename: s.filename, documentId: s.documentId, versionId: s.versionId, excerpts: sourceExcerpts(s, index + 1) })),
                    ...(packet.repair ? { repairInstruction: "The previous response failed the JSON shape or source-excerpt reference contract. Regenerate from this original evidence within all stated limits, using only supplied source-bound excerpt IDs. Do not infer that a previous draft was approved." } : {}),
                }),
                maxTokens: 6000, abortSignal: generationSignal });
        } catch (error) {
            return internalFailure(error);
        }
    }
    let content: MatterBriefContent;
    try {
        const generateAttempt = generate;
        content = await generateValidatedContent(repair => generateAttempt({ before: evidence[0].text, evidence, model: input.model, ...(repair ? { repair: true as const } : {}) }), evidence, resolve);
    }
    catch {
        return failure("validation", "The model did not return a valid proposal with exact source quotations. No document or review checkpoint was saved.");
    }
    const gaps = b.sources.filter(s => s.documentId !== b.brief!.documentId && !readable.some(r => r.documentId === s.documentId) && !s.reviewed)
        .map(s => ({ documentId: s.documentId, filename: s.filename, reason: s.reason ?? "Not selected for this proposal" }));
    const id = randomUUID(), versionId = randomUUID();
    const filename = "Reviewed matter brief.docx";
    const bytes = await renderProposalDocx({ content, evidence, gaps });
    const path = versionStorageKey(a.userId, b.brief.documentId, versionId, filename);
    // Durable cleanup precedes upload; failed requests/crashes cannot strand bytes.
    // The normal cleanup worker protects committed version references.
    const { error: cleanupError } = await db.from("db_jobs").insert({ kind: "document.cleanup", payload: { keys: [path] },
        dedupe_key: `brief-stage:${id}`, max_attempts: 5, run_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
    if (cleanupError)
        return internalFailure(cleanupError);
    await uploadFile(path, new Uint8Array(bytes).buffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const stagedVersion = { id: versionId, storage_path: path, filename, file_type: "docx", size_bytes: bytes.length, content_sha256: contentSha256(bytes), source: "assistant_edit" };
    const proposal = { id, designationId, base: stripText(snapshots[0]), sources: readable.map(stripText), content, before: evidence[0].text, gaps, stagedVersion };
    const { error } = await db.rpc("project_brief_save_proposal", { ...args(a), p_proposal: proposal });
    if (error)
        return dbFailure(error);
    return getBriefProposal(db, a, id);
}
export async function getBriefProposal(db: Db, a: Actor, id: string): Promise<ServiceResult<MatterBriefProposal>> {
    const gate = await bundle(db, a);
    if (!gate.ok)
        return gate;
    const { data, error } = await db.from("project_brief_proposals").select("*").eq("id", id).eq("project_id", a.projectId).eq("actor_id", a.userId).maybeSingle();
    if (error)
        return internalFailure(error);
    const proposal = data as StoredBriefProposal | null;
    if (!proposal)
        return failure("not_found", "The proposal is unavailable.");
    if (!proposal.applied_at && !contentSchema.safeParse(proposal.content).success)
        return failure("conflict", "The proposal uses an obsolete evidence contract. Prepare a new proposal citing selected source documents rather than the prior brief.");
    // Retained proposal text is not authority to read a document that has
    // since left this project. Native shared copies follow their own lifecycle.
    const currentDocuments = new Set(gate.data.sources.map(s => s.documentId));
    const references = [proposal.base, ...proposal.sources];
    if (!references.every(s => currentDocuments.has(s.documentId)))
        return failure("not_found", "The proposal is unavailable.");
    const { data: versions, error: versionsError } = await db.from("document_versions").select("id,document_id")
        .in("id", references.map(s => s.versionId)).is("deleted_at", null);
    if (versionsError)
        return internalFailure(versionsError);
    const liveVersions = new Map((versions ?? []).map((v: { id: string; document_id: string }) => [v.id, v.document_id]));
    if (!references.every(s => liveVersions.get(s.versionId) === s.documentId))
        return failure("not_found", "The proposal is unavailable.");
    return ok(toProposal(proposal));
}
export async function applyBrief(db: Db, a: Actor, id: string): Promise<ServiceResult<{
    versionId: string;
    replayed: boolean;
}>> {
    const gate = await bundle(db, a);
    if (!gate.ok)
        return gate;
    if (!gate.data.canEdit)
        return failure("forbidden", "Editing this project is not permitted.");
    // Check staged bytes before the transaction. Paths are immutable and private;
    // expired proposals cannot race the delayed cleanup job.
    const { data: q, error: readError } = await db.from("project_brief_proposals").select("staged_version,applied_at,content").eq("id", id).eq("project_id", a.projectId).eq("actor_id", a.userId).maybeSingle();
    if (readError)
        return internalFailure(readError);
    if (!q)
        return failure("not_found", "The proposal is unavailable.");
    if (!q.applied_at) {
        if (!contentSchema.safeParse(q.content).success)
            return failure("conflict", "The proposal uses an obsolete evidence contract. Prepare a new proposal citing selected source documents rather than the prior brief.");
        const bytes = await downloadFile(q.staged_version.storage_path);
        if (!bytes || contentSha256(bytes) !== q.staged_version.content_sha256)
            return failure("conflict", "The staged proposal is unavailable. Prepare a new proposal.");
    }
    const { data, error } = await applyReviewedBrief(db, { ...a, proposalId: id });
    return error ? dbFailure(error) : ok(data);
}
export async function readBriefSource(db: Db, a: Actor, input: {
    documentId: string;
    versionId: string;
    hash: string;
    revision: string;
}): Promise<ServiceResult<{
    bytes: ArrayBuffer;
    filename: string;
    mime: string;
}>> {
    const gate = await bundle(db, a);
    if (!gate.ok)
        return gate;
    // Authorize the document in its current project, then permit the exact live
    // historical version. Activating a new brief must not break its old citations.
    if (!gate.data.sources.some(s => s.documentId === input.documentId))
        return failure("not_found", "The source is unavailable.");
    const { data: v, error } = await db.from("document_versions").select("id,document_id,content_sha256,text_revision,storage_path,file_type,size_bytes")
        .eq("id", input.versionId).eq("document_id", input.documentId).is("deleted_at", null).maybeSingle();
    if (error)
        return internalFailure(error);
    if (!v)
        return failure("not_found", "The source is unavailable.");
    if (v.content_sha256 !== input.hash || v.text_revision !== input.revision)
        return failure("conflict", "This source changed after the proposal. The preserved quotation is historical; refresh to open its current version.");
    if (!v.size_bytes || v.size_bytes > 20000000)
        return failure("validation", "Open this source through the document viewer.");
    const bytes = await downloadFile(v.storage_path);
    if (!bytes || contentSha256(bytes) !== input.hash)
        return failure("conflict", "The stored source bytes changed or are unavailable.");
    const types: Record<string, {
        ext: string;
        mime: string;
    }> = { pdf: { ext: "pdf", mime: "application/pdf" }, docx: { ext: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }, doc: { ext: "doc", mime: "application/msword" }, xlsx: { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, pptx: { ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }, txt: { ext: "txt", mime: "text/plain" }, md: { ext: "md", mime: "text/plain" } };
    const kind = types[String(v.file_type).toLowerCase()] ?? Object.values(types).find(t => t.mime === v.file_type) ?? { ext: "bin", mime: "application/octet-stream" };
    return ok({ bytes, filename: `source.${kind.ext}`, mime: kind.mime });
}
