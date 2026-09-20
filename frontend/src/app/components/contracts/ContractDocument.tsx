"use client";

import { useEffect, useRef } from "react";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { clearDocxQuoteHighlights, highlightDocxQuote } from "@/app/components/shared/views/highlightDocxQuote";
import { getContractFileUrl } from "@/app/lib/mikeApi";
import { ContractHtmlView } from "./ContractHtmlView";
import type { ReviewDetailRow } from "./reviewTypes";

// Left pane of the workspace. Reviews with a persisted original render the real
// DOCX through Mike's viewer (tracked changes render natively); older reviews
// fall back to the sanitized mammoth HTML. Both support "Lihat di dokumen":
// the active finding's highlight_text is located with Mike's quote matcher.

export interface ContractDocumentProps {
    review: ReviewDetailRow;
    activeQuote: string | null;
    quoteFocusKey: number;
}

export function ContractDocument({ review, activeQuote, quoteFocusKey }: ContractDocumentProps) {
    if (review.contract_docx_path) {
        return (
            <DocxView
                documentId={review.id}
                displayUrl={getContractFileUrl(review.id)}
                quotes={activeQuote ? [{ quote: activeQuote }] : undefined}
                quoteFocusKey={quoteFocusKey}
                rounded={false}
            />
        );
    }
    return <HtmlWithQuote review={review} activeQuote={activeQuote} quoteFocusKey={quoteFocusKey} />;
}

function HtmlWithQuote({ review, activeQuote, quoteFocusKey }: ContractDocumentProps) {
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        clearDocxQuoteHighlights(root);
        if (!activeQuote) return;
        const match = highlightDocxQuote(root, activeQuote);
        match?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, [activeQuote, quoteFocusKey, review.contract_html]);

    return (
        <div ref={rootRef}>
            <ContractHtmlView html={review.contract_html} text={review.contract_text} />
        </div>
    );
}
