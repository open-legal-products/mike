import Image from "next/image";
import { Loader2 } from "lucide-react";
import { FileTypeIcon } from "../../shared/FileTypeIcon";
import { displayCitationQuote, formatCitationPage } from "../../shared/types";
import type { Citation } from "../../shared/types";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { RESPONSE_GLASS_SURFACE } from "./messageStyles";
import {
    citationVerificationAriaLabel,
    citationVerificationDescription,
    citationVerificationPillClassName,
} from "./citationVerification";

type CitationSourceRow = {
    key: string;
    label: string;
    source: Citation;
    entries: { annotation: Citation; index: number }[];
};

type LegalSourceType = "case" | "legislation";

function legalSourceType(annotation: Citation): LegalSourceType | null {
    if (annotation.kind === "case") return "case";
    const type = annotation.document?.type;
    return type === "case" || type === "legislation" ? type : null;
}

function citationSourceKey(annotation: Citation): string {
    if (annotation.kind === "case") {
        return `case:${annotation.cluster_id}`;
    }
    return `document:${annotation.document_id}`;
}

function citationSourceLabel(annotation: Citation): string {
    if (annotation.kind === "case") {
        const caseName = annotation.case_name?.trim();
        const citation = annotation.citation?.trim();
        if (caseName && citation) return `${caseName}, ${citation}`;
        return caseName || citation || `Case ${annotation.cluster_id}`;
    }
    if (legalSourceType(annotation)) {
        return annotation.document?.title || annotation.filename;
    }
    return annotation.filename;
}

export function citationTooltip(annotation: Citation): string {
    const locator = formatCitationPage(annotation);
    const quote = displayCitationQuote(annotation);
    const source = locator ? `${locator}: "${quote}"` : `"${quote}"`;
    const verification = citationVerificationDescription(annotation);
    return verification ? `${source} — ${verification}` : source;
}

function CitationSourceIcon({ annotation }: { annotation: Citation }) {
    const sourceType = legalSourceType(annotation);
    if (sourceType) {
        return (
            <Image
                src={
                    sourceType === "case"
                        ? "/icons/legal-sources/case-law.svg"
                        : "/icons/legal-sources/legislation.svg"
                }
                alt=""
                aria-hidden="true"
                width={14}
                height={14}
                className="h-3.5 w-3.5 shrink-0"
            />
        );
    }
    return (
        <FileTypeIcon
            fileType={annotation.kind === "case" ? null : annotation.filename}
            className="h-3.5 w-3.5"
        />
    );
}

function buildCitationSourceRows(citations: Citation[]): CitationSourceRow[] {
    const rows = new Map<string, CitationSourceRow>();
    citations.forEach((annotation, index) => {
        const key = citationSourceKey(annotation);
        const existing = rows.get(key);
        if (existing) {
            existing.entries.push({ annotation, index });
            return;
        }
        rows.set(key, {
            key,
            label: citationSourceLabel(annotation),
            source: annotation,
            entries: [{ annotation, index }],
        });
    });
    return Array.from(rows.values());
}

function escapeHtmlText(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function ensureTerminalPeriod(value: string): string {
    return /[.!?]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
}

export function buildCitationAppendix(citations: Citation[]) {
    if (citations.length === 0) return { html: "", text: "" };
    let previousSourceKey: string | null = null;
    const entries = citations.map((annotation) => {
        const sourceKey = citationSourceKey(annotation);
        const label =
            sourceKey === previousSourceKey
                ? "Id."
                : citationSourceLabel(annotation);
        previousSourceKey = sourceKey;
        return {
            number: annotation.ref,
            label,
            quote: displayCitationQuote(annotation).trim(),
        };
    });
    const textLines = [
        "",
        "Citations",
        ...entries.map((entry) => {
            const quote = entry.quote ? ` "${entry.quote}"` : "";
            return `${entry.number} ${ensureTerminalPeriod(entry.label)}${quote}`;
        }),
    ];
    const html = [
        `<section class="copied-citations">`,
        `<h3>Citations</h3>`,
        ...entries.map((entry) => {
            const label = escapeHtmlText(ensureTerminalPeriod(entry.label));
            const quote = entry.quote
                ? ` &quot;${escapeHtmlText(entry.quote)}&quot;`
                : "";
            return `<p><sup>${entry.number}</sup> ${label}${quote}</p>`;
        }),
        `</section>`,
    ].join("");
    return { html, text: textLines.join("\n") };
}

export function CitationsBlock({
    citations,
    activeCitation,
    onCitationClick,
    onOpenSource,
    canOpenSource,
    showWhenEmpty = false,
    isLoading = false,
}: {
    citations: Citation[];
    activeCitation?: Citation | null;
    onCitationClick?: (citation: Citation) => void;
    onOpenSource?: (citation: Citation) => void;
    canOpenSource?: (citation: Citation) => boolean;
    showWhenEmpty?: boolean;
    isLoading?: boolean;
}) {
    const rows = buildCitationSourceRows(citations);
    if (rows.length === 0 && !showWhenEmpty) return null;

    return (
        <div className="mt-2 mb-3">
            <div className={`overflow-hidden ${RESPONSE_GLASS_SURFACE}`}>
                <div className="flex items-center justify-between gap-3 bg-white/25 px-3 py-2">
                    <h3 className="text-base font-serif text-gray-900">
                        Citations
                    </h3>
                    {isLoading && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
                    )}
                </div>
                <div>
                    {rows.map((row) => {
                        const sourceIsClickable =
                            !!onOpenSource &&
                            (canOpenSource?.(row.source) ?? true);
                        return (
                            <div
                                key={row.key}
                                className="flex items-center gap-3 px-3 py-3"
                            >
                                <button
                                    type="button"
                                    onClick={() => onOpenSource?.(row.source)}
                                    disabled={!sourceIsClickable}
                                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm font-serif text-gray-700 transition-colors enabled:hover:text-gray-950 disabled:cursor-default"
                                >
                                    <CitationSourceIcon
                                        annotation={row.source}
                                    />
                                    <span className="truncate">
                                        {row.label}
                                    </span>
                                </button>
                                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                    {row.entries.map(
                                        ({ annotation, index }) => (
                                            <CitationPillUI
                                                key={`${row.key}:${index}`}
                                                active={
                                                    activeCitation ===
                                                    annotation
                                                }
                                                onClick={() =>
                                                    onCitationClick?.(
                                                        annotation,
                                                    )
                                                }
                                                className={citationVerificationPillClassName(
                                                    annotation,
                                                )}
                                                aria-label={citationVerificationAriaLabel(
                                                    annotation,
                                                )}
                                                title={citationTooltip(
                                                    annotation,
                                                )}
                                            >
                                                {annotation.ref}
                                            </CitationPillUI>
                                        ),
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
