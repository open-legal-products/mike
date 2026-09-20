"use client";

import { useMemo } from "react";
import DOMPurify from "dompurify";

// Read-only rendering of the mammoth-extracted contract HTML. This is the
// fallback for reviews that have no DOCX persisted in Mike (all reviews created
// before Phase 5 slice 3); reviews with a DOCX use Mike's DocxView instead.
// Inline styles are stripped by the sanitizer, so the bilingual two-column
// table layout Janus relied on is reproduced with the selectors below.
const CONTRACT_HTML_SANITIZER_CONFIG = {
    ALLOWED_TAGS: [
        "a", "blockquote", "br", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
        "hr", "li", "mark", "ol", "p", "s", "span", "strong", "sub", "sup",
        "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
    ],
    ALLOWED_ATTR: ["colspan", "rowspan", "href", "class"],
    FORBID_ATTR: ["style", "id", "onclick"],
    FORBID_TAGS: ["embed", "form", "iframe", "img", "input", "object", "script", "style", "svg"],
};

export function sanitizeContractHtml(value: string): string {
    return DOMPurify.sanitize(value, CONTRACT_HTML_SANITIZER_CONFIG);
}

export function ContractHtmlView({
    html,
    text,
}: {
    html: string | null;
    text: string | null;
}) {
    const sanitized = useMemo(() => (html ? sanitizeContractHtml(html) : ""), [html]);

    if (!sanitized && !text) {
        return (
            <div className="p-8 text-sm text-gray-500">
                Teks kontrak tidak tersedia untuk tampilan dokumen.
            </div>
        );
    }

    return (
        <article className="mx-auto w-full max-w-[860px] bg-white px-10 py-10 shadow-sm ring-1 ring-gray-200">
            {sanitized ? (
                <div
                    data-testid="contract-html"
                    className="font-serif text-[11pt] leading-[1.5] text-gray-900 [&_p]:my-2 [&_h1]:my-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:font-semibold [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_table]:my-3 [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_td]:w-1/2 [&_td]:border [&_td]:border-gray-400 [&_td]:p-2 [&_td]:align-top [&_th]:border [&_th]:border-gray-400 [&_th]:p-2 [&_th]:text-left [&_hr]:my-8 [&_hr]:border-dashed [&_hr]:border-gray-300 [&_a]:text-blue-600 [&_a]:underline"
                    dangerouslySetInnerHTML={{ __html: sanitized }}
                />
            ) : (
                <div className="whitespace-pre-wrap font-serif text-[11pt] leading-[1.5] text-gray-900">
                    {text}
                </div>
            )}
        </article>
    );
}
