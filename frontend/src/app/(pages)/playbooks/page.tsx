"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import mammoth from "mammoth";
import {
  AlertCircle, ChevronDown, ChevronRight, Loader2,
  Play, Plus, Save, Send, Trash2, Upload, X,
} from "lucide-react";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { Modal } from "@/app/components/modals/Modal";
import { ModalFieldLabel } from "@/app/components/modals/ModalFieldLabel";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalTextInput } from "@/app/components/modals/ModalTextInput";
import { PillButton } from "@/app/components/ui/pill-button";
import {
  modelDisplayName,
  SETTINGS_MODELS,
} from "@/app/components/assistant/ModelToggle";
import { useOllamaModels } from "@/app/hooks/useOllamaModels";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { buildPlaybookModelOptions } from "@/app/components/playbooks/playbookModelOptions";
import {
  deletePlaybook, getPlaybookConfiguration, importPlaybook, listPlaybooks,
  publishPlaybook, reviewDocumentWithPlaybook, updatePlaybook,
  type Playbook, type PlaybookClause, type PlaybookContent,
  type PlaybookConfiguration, type PlaybookPosition, type PlaybookRule,
  type PlaybookRun,
} from "@/app/lib/mikeApi";

function newRule(index: number): PlaybookRule {
  return { id: `rule-${crypto.randomUUID()}`, name: `New rule ${index}`, concept: "", scope: "clause", required: false, guidance: "", standard: null, fallbacks: [], unacceptable: [], conditions: [], actions: [], sourceRefs: [] };
}
function newPosition(name: string): PlaybookPosition { return { name, criteria: "", sampleClauses: [] }; }
function newClause(): PlaybookClause { return { text: "", usage: "illustrative", sourceRefs: [] }; }

async function extractReviewText(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".docx")) {
    return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  if (lower.endsWith(".pdf")) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(
        (content.items as Array<{ str?: string }>)
          .map((item) => item.str ?? "")
          .join(" "),
      );
    }
    return pages.map((text, index) => `[Page ${index + 1}]\n${text}`).join("\n\n");
  }
  return file.text();
}

const DEFAULT_REVIEW_INSTRUCTIONS =
  "Run a complete playbook review. Prioritize unacceptable and missing-required terms, quote exact contract language, and provide complete replacement language for issues that need revision.";

export default function PlaybooksPage() {
  const { profile } = useUserProfile();
  const ollamaModels = useOllamaModels();
  const configuredModelOptions = useMemo(
    () => [
      ...SETTINGS_MODELS,
      ...ollamaModels.map((model) => ({
        ...model,
        label: modelDisplayName(model.id),
        source: "Local",
      })),
    ],
    [ollamaModels],
  );
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlaybookContent | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [configuration, setConfiguration] = useState<PlaybookConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importName, setImportName] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewFile, setReviewFile] = useState<File | null>(null);
  const [reviewInstructions, setReviewInstructions] = useState(DEFAULT_REVIEW_INSTRUCTIONS);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewMode, setReviewMode] = useState<"strict" | "permissive">("strict");
  const [run, setRun] = useState<PlaybookRun | null>(null);

  const selected = playbooks.find((item) => item.id === selectedId) ?? null;
  const selectedRule = useMemo(() => draft?.topics.flatMap((topic) => topic.rules).find((rule) => rule.id === selectedRuleId) ?? null, [draft, selectedRuleId]);
  const models = useMemo(
    () => buildPlaybookModelOptions(
      configuredModelOptions,
      configuration,
      profile?.apiKeys,
    ),
    [configuration, configuredModelOptions, profile?.apiKeys],
  );

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [items, configuration] = await Promise.all([listPlaybooks(), getPlaybookConfiguration()]);
      setPlaybooks(items);
      setConfiguration(configuration);
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load playbooks."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setModel((current) => {
      if (models.some((entry) => entry.value === current)) return current;
      if (configuration?.defaultModel && models.some((entry) => entry.value === configuration.defaultModel)) {
        return configuration.defaultModel;
      }
      return models[0]?.value ?? "";
    });
  }, [configuration?.defaultModel, models]);
  useEffect(() => {
    if (!selected) { setDraft(null); setSelectedRuleId(null); return; }
    setDraft(structuredClone(selected.draft));
    setExpandedTopics(new Set(selected.draft.topics.map((topic) => topic.id)));
    setSelectedRuleId(selected.draft.topics[0]?.rules[0]?.id ?? null);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  function replaceRule(next: PlaybookRule) {
    setDraft((current) => current ? { ...current, topics: current.topics.map((topic) => ({ ...topic, rules: topic.rules.map((rule) => rule.id === next.id ? next : rule) })) } : current);
  }

  async function doImport() {
    if (!importFile) return;
    setBusy("import"); setError(null); setImportError(null);
    try {
      const created = await importPlaybook(importFile, model, importName);
      setPlaybooks((current) => [created, ...current]); setSelectedId(created.id); setImportOpen(false); setImportFile(null); setImportName("");
    } catch (err) { setImportError(err instanceof Error ? err.message : "Import failed."); }
    finally { setBusy(null); }
  }

  async function save() {
    if (!selected || !draft) return;
    setBusy("save"); setError(null);
    try { const saved = await updatePlaybook(selected.id, draft); setPlaybooks((items) => items.map((item) => item.id === saved.id ? saved : item)); }
    catch (err) { setError(err instanceof Error ? err.message : "Save failed."); }
    finally { setBusy(null); }
  }

  async function publish() {
    if (!selected) return;
    setBusy("publish"); setError(null);
    try { if (draft) await updatePlaybook(selected.id, draft); const saved = await publishPlaybook(selected.id); setPlaybooks((items) => items.map((item) => item.id === saved.id ? saved : item)); }
    catch (err) { setError(err instanceof Error ? err.message : "Publish failed."); }
    finally { setBusy(null); }
  }

  async function remove() {
    if (!selected || !window.confirm(`Delete “${selected.name}”?`)) return;
    setBusy("delete");
    try { await deletePlaybook(selected.id); const remaining = playbooks.filter((item) => item.id !== selected.id); setPlaybooks(remaining); setSelectedId(remaining[0]?.id ?? null); }
    catch (err) { setError(err instanceof Error ? err.message : "Delete failed."); }
    finally { setBusy(null); }
  }

  async function review() {
    if (!selected || !reviewFile) return;
    setBusy("review"); setError(null); setReviewError(null);
    try {
      const documentText = await extractReviewText(reviewFile);
      const result = await reviewDocumentWithPlaybook(selected.id, { documentText, documentName: reviewFile.name, instructions: reviewInstructions, model, reviewMode });
      setRun(result); setReviewOpen(false);
    } catch (err) { setReviewError(err instanceof Error ? err.message : "Review failed."); }
    finally { setBusy(null); }
  }

  function addRule(topicId: string) {
    if (!draft) return;
    const rule = newRule(draft.topics.flatMap((topic) => topic.rules).length + 1);
    setDraft({ ...draft, topics: draft.topics.map((topic) => topic.id === topicId ? { ...topic, rules: [...topic.rules, rule] } : topic) });
    setSelectedRuleId(rule.id);
  }

  return <div className="flex h-full min-h-0 flex-col">
    <PageHeader breadcrumbs={[{ label: "Playbooks" }]} actions={[{ icon: <Upload className="h-4 w-4" />, label: "Import Word", onClick: () => setImportOpen(true) }]} />
    {error && <div role="alert" className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 md:mx-6"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{error}</span><button onClick={() => setError(null)} aria-label="Dismiss"><X className="h-4 w-4" /></button></div>}
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[280px_300px_minmax(0,1fr)] md:overflow-hidden">
      <aside className="max-h-48 overflow-y-auto border-b border-gray-200 px-3 pb-5 md:max-h-none md:border-b-0 md:border-r">
        {loading ? <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin" /></div> : playbooks.length === 0 ? <div className="px-3 py-12 text-center text-sm text-gray-500">Import a Word playbook to begin.</div> : playbooks.map((item) => <button key={item.id} onClick={() => setSelectedId(item.id)} className={`mb-1 w-full rounded-md px-3 py-2.5 text-left ${selectedId === item.id ? "bg-gray-900 text-white" : "hover:bg-gray-100"}`}><div className="truncate text-sm font-medium">{item.name}</div><div className={`mt-1 flex gap-2 text-xs ${selectedId === item.id ? "text-gray-300" : "text-gray-500"}`}><span>{item.status === "published" ? `Published v${item.publishedVersionNumber}` : "Draft"}</span><span>{item.draft.topics.reduce((sum, topic) => sum + topic.rules.length, 0)} rules</span></div></button>)}
      </aside>
      <aside className="max-h-56 overflow-y-auto border-b border-gray-200 px-3 py-3 md:max-h-none md:border-b-0 md:border-r md:py-0 md:pb-5">
        {draft && <>
          <div className="mb-3 flex items-center justify-between px-2"><span className="text-xs font-semibold uppercase text-gray-500">Topics and rules</span><button title="Add topic" onClick={() => { const id = `topic-${crypto.randomUUID()}`; setDraft({ ...draft, topics: [...draft.topics, { id, name: "New topic", rules: [newRule(1)] }] }); setExpandedTopics(new Set([...expandedTopics, id])); }}><Plus className="h-4 w-4" /></button></div>
          {draft.topics.map((topic, topicIndex) => <div key={topic.id} className="mb-2">
            <div className="flex items-center gap-1"><button onClick={() => setExpandedTopics((current) => { const next = new Set(current); if (next.has(topic.id)) next.delete(topic.id); else next.add(topic.id); return next; })}>{expandedTopics.has(topic.id) ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button><input value={topic.name} onChange={(event) => setDraft({ ...draft, topics: draft.topics.map((item) => item.id === topic.id ? { ...item, name: event.target.value } : item) })} className="min-w-0 flex-1 border-0 bg-transparent px-1 py-1 text-sm font-semibold outline-none" aria-label={`Topic ${topicIndex + 1} name`} /><button title="Add rule" onClick={() => addRule(topic.id)}><Plus className="h-3.5 w-3.5" /></button></div>
            {expandedTopics.has(topic.id) && <div className="ml-5 mt-1 space-y-1">{topic.rules.map((rule) => <button key={rule.id} onClick={() => setSelectedRuleId(rule.id)} className={`w-full rounded-md px-2 py-1.5 text-left text-xs ${selectedRuleId === rule.id ? "bg-gray-200 text-gray-900" : "text-gray-600 hover:bg-gray-100"}`}>{rule.name}</button>)}</div>}
          </div>)}
        </>}
      </aside>
      <main className="min-h-[600px] min-w-0 overflow-visible px-5 pb-8 md:min-h-0 md:overflow-y-auto">
        {!draft || !selected ? <div className="py-16 text-center text-sm text-gray-500">Select a playbook.</div> : <>
          <div className="sticky top-0 z-10 mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-app-background py-3">
            <div><div className="text-xs text-gray-500">{selected.sourceFilename || "Manual playbook"}</div><div className="text-sm font-medium">{selected.status === "published" ? `Published version ${selected.publishedVersionNumber}` : "Unpublished draft"}</div></div>
            <div className="flex gap-2"><PillButton tone="white" onClick={() => setReviewOpen(true)} disabled={!selected.publishedVersionId}><Play className="h-3.5 w-3.5" />Review document</PillButton><PillButton tone="white" onClick={() => void save()} disabled={!!busy}><Save className="h-3.5 w-3.5" />Save</PillButton><PillButton tone="black" onClick={() => void publish()} disabled={!!busy}><Send className="h-3.5 w-3.5" />Publish</PillButton><button title="Delete playbook" onClick={() => void remove()} className="p-2 text-gray-500 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></div>
          </div>
          <section className="mb-6 grid gap-4 md:grid-cols-2"><Field label="Playbook name" value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} /><Field label="Represented party" value={draft.representedParty} onChange={(value) => setDraft({ ...draft, representedParty: value })} /><Field label="Description" value={draft.description} onChange={(value) => setDraft({ ...draft, description: value })} multiline /><Field label="Global guidance" value={draft.globalGuidance} onChange={(value) => setDraft({ ...draft, globalGuidance: value })} multiline /></section>
          {selectedRule ? <RuleEditor rule={selectedRule} onChange={replaceRule} onDelete={() => { setDraft({ ...draft, topics: draft.topics.map((topic) => ({ ...topic, rules: topic.rules.filter((rule) => rule.id !== selectedRule.id) })).filter((topic) => topic.rules.length) }); setSelectedRuleId(null); }} /> : <div className="border-t border-gray-200 py-12 text-center text-sm text-gray-500">Select a rule to edit.</div>}
          {run && <ReviewResults run={run} />}
        </>}
      </main>
    </div>
    <Modal open={importOpen} onClose={() => { if (busy !== "import") { setImportOpen(false); setImportError(null); } }} size="sm" breadcrumbs={["Playbooks", "Import Word playbook"]} footerStatus={busy === "import" ? <span className="text-xs text-gray-500">Long files can take several minutes</span> : null} primaryAction={{ label: busy === "import" ? "Compiling…" : "Import and compile", icon: busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />, variant: "blue", disabled: !importFile || !model || !!busy, onClick: () => void doImport() }} cancelAction={{ label: "Cancel", onClick: () => { setImportOpen(false); setImportError(null); }, disabled: busy === "import" }}><div className="space-y-4 overflow-y-auto pb-4"><p className="text-sm text-gray-600">The imported concepts, positions, and sample clauses remain a draft until you review and publish them.</p>{busy === "import" && <div role="status" className="flex items-start gap-2 rounded-xl border border-blue-300/70 bg-blue-50 px-3 py-2.5 text-sm text-blue-800"><Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /><span>The model is compiling and validating the playbook. If its first response is invalid, MikeOSS will automatically retry it. Keep this window open.</span></div>}{importError && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-300/70 bg-red-50 px-3 py-2.5 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{importError}</span></div>}<div><ModalFieldLabel>Playbook name (optional)</ModalFieldLabel><ModalTextInput value={importName} onChange={(event) => setImportName(event.target.value)} /></div><div><ModalFieldLabel>Word playbook</ModalFieldLabel><input type="file" accept=".docx" onChange={(event) => { setImportFile(event.target.files?.[0] ?? null); setImportError(null); }} className="block w-full text-sm" /></div><div><ModalFieldLabel>Compilation model</ModalFieldLabel>{models.length > 0 ? <ModalSelect id="playbook-import-model" value={model} onChange={(value) => { setModel(value); setImportError(null); }} options={models} menuClassName="max-h-64" /> : <p className="text-sm text-amber-700">No compilation model is available. <a href="/account/api-keys" className="underline">Configure an API key</a> or enable a local model.</p>}</div></div></Modal>
    <Modal open={reviewOpen} onClose={() => { if (busy !== "review") { setReviewOpen(false); setReviewError(null); } }} size="sm" breadcrumbs={["Playbooks", "Review document"]} footerStatus={busy === "review" ? <span className="flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Reviewing the document…</span> : null} primaryAction={{ label: busy === "review" ? "Reviewing…" : "Start review", icon: busy === "review" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />, variant: "blue", disabled: !reviewFile || !model || !!busy, onClick: () => void review() }} cancelAction={{ label: "Cancel", onClick: () => { setReviewOpen(false); setReviewError(null); }, disabled: busy === "review" }}><div className="space-y-4 overflow-y-auto pb-4">{reviewError && <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-300/70 bg-red-50 px-3 py-2.5 text-sm text-red-700"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{reviewError}</span></div>}<div><ModalFieldLabel>Contract</ModalFieldLabel><input type="file" accept=".pdf,.docx,.txt" onChange={(event) => { setReviewFile(event.target.files?.[0] ?? null); setReviewError(null); }} className="block w-full text-sm" /><p className="mt-1 text-xs text-gray-500">PDF, DOCX, or TXT files are supported. PDFs are reviewed from extracted text; keep the original Word file if you need formatting-preserving redlines.</p></div><div><ModalFieldLabel>Review instructions</ModalFieldLabel><textarea value={reviewInstructions} onChange={(event) => setReviewInstructions(event.target.value)} rows={4} aria-label="Review instructions" className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400 focus:ring-2 focus:ring-blue-200" /><div className="mt-2 flex flex-wrap gap-2" aria-label="Suggested review prompts">{["Run a complete playbook review. Prioritize unacceptable and missing-required terms, quote exact contract language, and provide complete replacement language for issues that need revision.", "Show only unacceptable and missing-required terms.", "Explain the highest-risk deviations and propose redlines."].map((suggestion) => <button key={suggestion} type="button" onClick={() => setReviewInstructions(suggestion)} className="rounded-full border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-300">{suggestion.length > 55 ? "Complete review" : suggestion}</button>)}</div></div><div><ModalFieldLabel>Review model</ModalFieldLabel>{models.length > 0 ? <ModalSelect id="playbook-review-model" value={model} onChange={(value) => { setModel(value); setReviewError(null); }} options={models} menuClassName="max-h-64" /> : <p className="text-sm text-amber-700">No review model is available. <a href="/account/api-keys" className="underline">Configure an API key</a> or enable a local model.</p>}</div><div><ModalFieldLabel>Review posture</ModalFieldLabel><ModalSelect id="playbook-review-mode" value={reviewMode} onChange={(value) => setReviewMode(value as "strict" | "permissive")} options={[{ value: "strict", label: "Strict — push standard positions" }, { value: "permissive", label: "Permissive — allow fallbacks" }]} /></div></div></Modal>
  </div>;
}

function Field({ label, value, onChange, multiline = false }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean }) {
  return <label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>{multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400" /> : <input value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-gray-400" />}</label>;
}

function RuleEditor({ rule, onChange, onDelete }: { rule: PlaybookRule; onChange: (rule: PlaybookRule) => void; onDelete: () => void }) {
  return <section className="border-t border-gray-200 pt-5"><div className="mb-4 flex items-center justify-between"><h2 className="font-serif text-xl">Rule</h2><button onClick={onDelete} title="Delete rule" className="text-gray-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button></div><div className="grid gap-4 md:grid-cols-2"><Field label="Rule name" value={rule.name} onChange={(name) => onChange({ ...rule, name })} /><label className="block"><span className="mb-1 block text-xs font-medium text-gray-600">Scope</span><select value={rule.scope} onChange={(event) => onChange({ ...rule, scope: event.target.value as "clause" | "agreement" })} className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"><option value="clause">Clause</option><option value="agreement">Whole agreement</option></select></label><div className="md:col-span-2"><Field label="Concept to detect" value={rule.concept} onChange={(concept) => onChange({ ...rule, concept })} multiline /></div><div className="md:col-span-2"><Field label="Guidance" value={rule.guidance} onChange={(guidance) => onChange({ ...rule, guidance })} multiline /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={rule.required} onChange={(event) => onChange({ ...rule, required: event.target.checked })} />Clause is required</label></div><div className="mt-6 space-y-5"><PositionGroup title="Standard position" positions={rule.standard ? [rule.standard] : []} single onChange={(positions) => onChange({ ...rule, standard: positions[0] ?? null })} /><PositionGroup title="Fallback positions" positions={rule.fallbacks} onChange={(fallbacks) => onChange({ ...rule, fallbacks })} /><PositionGroup title="Unacceptable positions" positions={rule.unacceptable} onChange={(unacceptable) => onChange({ ...rule, unacceptable })} /></div>{rule.sourceRefs.length > 0 && <div className="mt-5 text-xs text-gray-500">Imported from {rule.sourceRefs.join(", ")}</div>}</section>;
}

function PositionGroup({ title, positions, onChange, single = false }: { title: string; positions: PlaybookPosition[]; onChange: (positions: PlaybookPosition[]) => void; single?: boolean }) {
  return <div><div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-semibold">{title}</h3>{(!single || positions.length === 0) && <button onClick={() => onChange([...positions, newPosition(title.replace(/ positions?$/i, ""))])} title={`Add ${title.toLowerCase()}`}><Plus className="h-4 w-4" /></button>}</div>{positions.length === 0 ? <div className="text-xs text-gray-500">Not defined.</div> : positions.map((position, positionIndex) => <div key={positionIndex} className="mb-3 border-l-2 border-gray-200 pl-4"><div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto]"><Field label="Position name" value={position.name} onChange={(name) => onChange(positions.map((item, index) => index === positionIndex ? { ...item, name } : item))} /><Field label="Criteria" value={position.criteria} onChange={(criteria) => onChange(positions.map((item, index) => index === positionIndex ? { ...item, criteria } : item))} multiline /><button className="mt-6 text-gray-400 hover:text-red-600" onClick={() => onChange(positions.filter((_, index) => index !== positionIndex))} title="Remove position"><X className="h-4 w-4" /></button></div><div className="mt-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-gray-600">Sample clauses</span><button title="Add sample clause" onClick={() => onChange(positions.map((item, index) => index === positionIndex ? { ...item, sampleClauses: [...item.sampleClauses, newClause()] } : item))}><Plus className="h-3.5 w-3.5" /></button></div>{position.sampleClauses.map((clause, clauseIndex) => <div key={clauseIndex} className="mb-2 grid gap-2 md:grid-cols-[140px_minmax(0,1fr)_auto]"><select value={clause.usage} onChange={(event) => onChange(positions.map((item, index) => index === positionIndex ? { ...item, sampleClauses: item.sampleClauses.map((entry, cIndex) => cIndex === clauseIndex ? { ...entry, usage: event.target.value as PlaybookClause["usage"] } : entry) } : item))} className="rounded-md border border-gray-200 bg-white px-2 py-2 text-xs"><option value="illustrative">Illustrative</option><option value="preferred">Preferred</option><option value="verbatim">Verbatim</option><option value="accepted">Previously accepted</option><option value="unacceptable">Unacceptable</option></select><textarea value={clause.text} onChange={(event) => onChange(positions.map((item, index) => index === positionIndex ? { ...item, sampleClauses: item.sampleClauses.map((entry, cIndex) => cIndex === clauseIndex ? { ...entry, text: event.target.value } : entry) } : item))} rows={3} className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm" /><button title="Remove sample clause" onClick={() => onChange(positions.map((item, index) => index === positionIndex ? { ...item, sampleClauses: item.sampleClauses.filter((_, cIndex) => cIndex !== clauseIndex) } : item))}><X className="h-4 w-4 text-gray-400" /></button></div>)}</div></div>)}</div>;
}

function ReviewResults({ run }: { run: PlaybookRun }) {
  const tone: Record<string, string> = { acceptable: "bg-green-100 text-green-800", not_applicable: "bg-gray-100 text-gray-700", needs_review: "bg-amber-100 text-amber-900", unacceptable: "bg-red-100 text-red-800", missing_required: "bg-red-100 text-red-800", outside_scope: "bg-blue-100 text-blue-800" };
  const isWordSource = !!run.documentName && /\.docx?$/i.test(run.documentName);
  return <section className="mt-8 border-t border-gray-200 pt-5"><h2 className="font-serif text-xl">Latest review</h2><p className="mt-2 text-sm text-gray-700">{run.summary}</p>{run.documentName && !isWordSource && <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm text-blue-900">This review used extracted text from <span className="font-medium">{run.documentName}</span>. For a formatting-preserving Word redline, provide the original DOCX in Assistant; if it is unavailable, Mike can create a text-reconstructed DOCX and will warn that formatting may differ.</div>}<div className="mt-4 space-y-3">{run.findings.map((finding) => <article key={finding.id} className="rounded-md border border-gray-200 bg-white p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{finding.ruleName}</h3><span className={`rounded px-2 py-1 text-[11px] font-medium ${tone[finding.status]}`}>{finding.status.replaceAll("_", " ")}</span></div>{finding.location && <div className="mt-1 text-xs text-gray-500">{finding.location}</div>}<p className="mt-2 text-sm text-gray-700">{finding.analysis}</p>{finding.quote && <blockquote className="mt-2 border-l-2 border-gray-300 pl-3 text-xs text-gray-600">{finding.quote}</blockquote>}{finding.suggestedText && <div className="mt-3 text-xs"><span className="font-semibold">Suggested language:</span> {finding.suggestedText}</div>}</article>)}</div></section>;
}
