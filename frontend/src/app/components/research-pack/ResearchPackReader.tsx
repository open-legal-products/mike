"use client";

import { useRef, useState } from "react";
import {
    type OpenResearchPack,
    type ResearchPackRevision,
    verifyResearchPackFile,
} from "@/app/lib/researchPackClient";

const text = (value: unknown) =>
    typeof value === "string" ? value : value == null ? "—" : String(value);
const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? value as Record<string, unknown> : {};
function Field({ label, value }: { label: string; value: unknown }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
            <dd className="mt-1 break-words whitespace-pre-wrap text-sm text-gray-800">
                {text(value)}
            </dd>
        </div>
    );
}
function Revision({ revision }: { revision: ResearchPackRevision }) {
    const finding = object(revision.finding);
    const context = object(revision.context_selection);
    const notes = object(context.notes);
    const researchContext = Array.isArray(revision.research_context)
        ? revision.research_context
        : [];
    const propositions = Array.isArray(revision.propositions) ? revision.propositions : [];
    const assessments = Array.isArray(revision.assessments) ? revision.assessments : [];
    return (
        <article className="rounded-xl border border-gray-200 bg-white p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-medium text-gray-900">Revision {revision.revision}</h2>
                <span className="text-xs text-gray-500">Saved {text(revision.saved_at)}</span>
            </div>
            <p className="mt-4 break-words text-sm font-medium text-gray-900">
                {text(revision.question)}
            </p>
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <Field label="Finding author" value={finding.author} />
                <Field label="Finding" value={finding.text ?? revision.finding} />
            </div>
            <h3 className="mt-6 text-sm font-semibold text-gray-700">
                References and observations (recorded, not fetched)
            </h3>
            <div className="mt-2 space-y-3">
                {(Array.isArray(revision.observations) ? revision.observations : []).map(
                    (item) => {
                        const observation = object(item);
                        const metadata = object(observation.metadata_at_save);
                        return (
                            <div
                                key={String(observation.observation_id ?? "")}
                                className="rounded-lg bg-gray-50 p-4"
                            >
                                <dl className="grid gap-3 sm:grid-cols-2">
                                    <Field
                                        label="Observation ID"
                                        value={observation.observation_id}
                                    />
                                    <Field label="Title" value={metadata.title} />
                                    <Field label="Source kind" value={observation.source_kind} />
                                    <Field
                                        label="Recorded address"
                                        value={metadata.href ?? metadata.page}
                                    />
                                    <Field label="Provenance" value={metadata.provenance_note} />
                                </dl>
                                <details className="mt-3">
                                    <summary className="cursor-pointer text-sm font-medium text-gray-700">
                                        Exact reference
                                    </summary>
                                    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-gray-700">{JSON.stringify(observation.reference ?? null, null, 2)}</pre>
                                </details>
                            </div>
                        );
                    },
                )}
            </div>
            <h3 className="mt-6 text-sm font-semibold text-gray-700">
                Propositions and authored assessments
            </h3>
            <div className="mt-2 space-y-3">
                {propositions.length === 0 && (
                    <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">
                        No propositions recorded.
                    </p>
                )}
                {propositions.map((item) => {
                    const proposition = object(item);
                    const propositionId = text(proposition.proposition_id);
                    const linked = assessments.filter((candidate) => {
                        const assessment = object(candidate);
                        return assessment.proposition_id === proposition.proposition_id;
                    });
                    return (
                        <div key={propositionId} className="rounded-lg bg-gray-50 p-4">
                            <dl className="grid gap-3 sm:grid-cols-2">
                                <Field label="Proposition ID" value={proposition.proposition_id} />
                                <Field label="Proposition text" value={proposition.text} />
                            </dl>
                            <div className="mt-3 space-y-2 border-l-2 border-gray-200 pl-4">
                                {linked.length === 0 && (
                                    <p className="text-sm text-gray-600">
                                        No assessments recorded for this proposition.
                                    </p>
                                )}
                                {linked.map((candidate) => {
                                    const assessment = object(candidate);
                                    const pair = `${proposition.proposition_id ?? ""}:${
                                        assessment.observation_id ?? ""
                                    }`;
                                    return (
                                        <dl key={pair} className="grid gap-3 sm:grid-cols-4">
                                            <Field
                                                label="Assessment observation ID"
                                                value={assessment.observation_id}
                                            />
                                            <Field label="Author" value={assessment.author} />
                                            <Field label="Stance" value={assessment.stance} />
                                            <Field label="Note" value={assessment.note} />
                                        </dl>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </div>
            <h3 className="mt-6 text-sm font-semibold text-gray-700">
                Selected revision context reviews
            </h3>
            <div className="mt-2 space-y-2">
                {researchContext.map((item) => {
                    const contextRecord = object(item);
                    const review = object(contextRecord.review);
                    return (
                        <dl
                            key={text(contextRecord.context_id)}
                            className="grid gap-3 rounded-lg bg-gray-50 p-4 sm:grid-cols-3"
                        >
                            <Field
                                label="Context ID"
                                value={contextRecord.context_id ?? "none"}
                            />
                            <Field label="Decision" value={review.decision ?? "none"} />
                            <Field label="Review note" value={review.note ?? "none"} />
                        </dl>
                    );
                })}
            </div>
            <h3 className="mt-6 text-sm font-semibold text-gray-700">
                Original context selection notes
            </h3>
            <dl className="mt-2 grid gap-3 rounded-lg bg-gray-50 p-4 sm:grid-cols-2">
                <Field label="Original working answer" value={notes.working_answer} />
                <Field label="Original still to check" value={notes.still_to_check} />
            </dl>
        </article>
    );
}

export function ResearchPackReader() {
    const inputRef = useRef<HTMLInputElement>(null);
    const sequence = useRef(0);
    const [opened, setOpened] = useState<OpenResearchPack | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [selected, setSelected] = useState(1);
    const [busy, setBusy] = useState(false);
    async function open(file: File) {
        const ticket = ++sequence.current;
        setBusy(true);
        setError(null);
        setOpened(null);
        setSelected(1);
        try {
            const next = await verifyResearchPackFile(file);
            if (ticket !== sequence.current) return;
            setOpened(next);
            setSelected(next.pack.selected_revision);
        } catch (cause) {
            if (ticket === sequence.current) {
                setOpened(null);
                setError(
                    cause instanceof Error
                        ? cause.message
                        : "The selected file could not be opened.",
                );
            }
        } finally {
            if (ticket === sequence.current) setBusy(false);
        }
    }
    function download() {
        if (!opened || busy) return;
        const url = URL.createObjectURL(opened.file);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = opened.file.name || "research-pack.json";
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    const revision = opened?.pack.revisions.find((item) => item.revision === selected);
    const reportAuthenticity = text(opened?.report.authenticity ?? opened?.pack.authenticity);
    return (
        <section
            aria-label="Research Pack contents"
            tabIndex={0}
            className="mx-auto w-full max-w-5xl shrink-0 px-6 py-10 focus-visible:outline-offset-[-2px] md:min-h-0 md:flex-1 md:overflow-y-auto"
        >
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="text-sm text-gray-500">Counterpedia interoperability</p>
                    <h1 className="text-3xl font-serif text-gray-900">Open Research Pack</h1>
                    <p className="mt-2 max-w-2xl text-sm text-gray-600">
                        Inspect a verified v0.2 research history. Imported text is read-only and
                        recorded addresses are never fetched.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => inputRef.current?.click()}
                        className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                        Open Research Pack
                    </button>
                    <input
                        ref={inputRef}
                        type="file"
                        accept="application/json,.json"
                        className="sr-only"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) void open(file);
                        }}
                    />
                    <button
                        type="button"
                        disabled={!opened || busy}
                        onClick={download}
                        className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-800 disabled:opacity-50"
                    >
                        Download original pack
                    </button>
                </div>
            </div>
            {busy && (
                <p role="status" className="mb-6 text-sm text-gray-600">
                    Verifying selected file…
                </p>
            )}
            {error && (
                <div
                    role="alert"
                    className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
                >
                    {error}
                </div>
            )}
            {!opened && !error && !busy && (
                <div className="rounded-xl border border-dashed border-gray-300 p-12 text-center text-sm text-gray-500">
                    Choose a Counterpedia v0.2 JSON file to begin.
                </div>
            )}
            {opened && (
                <div className="space-y-6">
                    <section className="rounded-xl border border-gray-200 bg-white p-6">
                        <p className="text-xs uppercase tracking-wide text-gray-500">
                            Verified file
                        </p>
                        <h2 className="mt-2 break-words text-xl font-medium text-gray-900">
                            {opened.file.name}
                        </h2>
                        <p className="mt-2 break-words text-sm text-gray-600">
                            Schema {opened.pack.schema} · integrity: {opened.report.integrity}{" "}
                            · authenticity: {reportAuthenticity} · export observed at{" "}
                            {text(opened.pack.export.exported_at)}
                        </p>
                        <label className="mt-4 inline-block text-sm">
                            Revision{" "}
                            <select
                                aria-label="Revision"
                                value={selected}
                                onChange={(event) => setSelected(Number(event.target.value))}
                                className="ml-1 rounded border px-2 py-1"
                            >
                                {opened.pack.revisions.map((item) => (
                                    <option key={item.revision} value={item.revision}>
                                        {item.revision}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </section>
                    {revision && <Revision revision={revision} />}
                    <section className="rounded-xl border border-gray-200 bg-white p-6">
                        <h2 className="text-sm font-semibold text-gray-700">
                            Export-time readback availability
                        </h2>
                        {(Array.isArray(opened.pack.export.readback)
                            ? opened.pack.export.readback
                            : [])
                            .map((item) => {
                                const readback = object(item);
                                const rowRevision = opened.pack.revisions.find((candidate) =>
                                    candidate.revision === readback.revision
                                );
                                const matchingObservation =
                                    (Array.isArray(rowRevision?.observations)
                                        ? rowRevision.observations
                                        : [])
                                        .map(object)
                                        .find((observation) =>
                                            observation.observation_id ===
                                                readback.observation_id
                                        );
                                const matchingTitle =
                                    object(matchingObservation?.metadata_at_save).title;
                                return (
                                    <dl
                                        key={`${text(readback.revision)}:${
                                            text(readback.observation_id)
                                        }`}
                                        className="mt-3 grid gap-3 rounded-lg bg-gray-50 p-4 sm:grid-cols-5"
                                    >
                                        <Field label="Revision" value={readback.revision} />
                                        <Field
                                            label="Observation ID"
                                            value={readback.observation_id}
                                        />
                                        <Field
                                            label="Observation title"
                                            value={matchingTitle}
                                        />
                                        <Field label="State" value={readback.state} />
                                        <Field label="Basis" value={readback.basis} />
                                        <Field
                                            label="Observed at"
                                            value={readback.observed_at}
                                        />
                                    </dl>
                                );
                            })}
                    </section>
                </div>
            )}
        </section>
    );
}
