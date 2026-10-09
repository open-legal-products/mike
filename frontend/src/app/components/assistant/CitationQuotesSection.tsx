"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { QuoteIcon } from "@radix-ui/react-icons";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { TextSlabUI } from "@/shared/ui/TextSlabUI";
import type { PanelDocument, PanelDocumentQuote } from "../shared/types";
import {
    CitationVerificationBadge,
    quoteVerificationState,
    type CitationVerificationDisplayState,
} from "./message/citationVerification";
import { ContextNumberBadge } from "./ContextNumberBadge";
import { RESPONSE_GLASS_SURFACE } from "./message/messageStyles";

export type CitationQuoteSectionItem = {
    id: string;
    quote: string;
    quoteLabel?: string | null;
    verificationState?: CitationVerificationDisplayState;
};

interface CommonProps {
    error?: string | null;
    isLoading?: boolean;
    activeQuoteId?: string | null;
    citationRef?: number;
    onSelect?: (quote: CitationQuoteSectionItem, index: number) => void;
    onIndexChange?: (index: number) => void;
    /** Renders the dismiss control. Omit where the section cannot be closed. */
    onClose?: () => void;
}

type Props = CommonProps &
    (
        | {
              document: PanelDocument;
              quotes?: never;
              currentIndex?: number;
          }
        | {
              document?: never;
              quotes: CitationQuoteSectionItem[];
              currentIndex?: number;
          }
    );

const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";

export function documentQuoteId(documentId: string, index: number): string {
    return `${documentId}:quote:${index}`;
}

function formatCellTarget(quote: PanelDocumentQuote): string | null {
    const { sheet, cell } = quote.target;
    if (!cell) return sheet ?? null;
    const cellWord = cell.includes(":") ? "cells" : "cell";
    const cellPart = `${cellWord} ${cell}`;
    return sheet ? `${sheet}, ${cellPart}` : cellPart;
}

function formatQuoteTarget(quote: PanelDocumentQuote): string | null {
    if (quote.target.sheet || quote.target.cell) {
        return formatCellTarget(quote);
    }
    return quote.target.page !== undefined ? `Page ${quote.target.page}` : null;
}

function documentQuoteItems(
    document: PanelDocument,
): CitationQuoteSectionItem[] {
    return document.quotes.map((quote, index) => {
        const locator = formatQuoteTarget(quote);
        return {
            id: documentQuoteId(document.document_id, index),
            quote: quote.quote.replaceAll(PAGE_BREAK_SENTINEL, "..."),
            quoteLabel: locator,
            verificationState: quoteVerificationState(quote),
        };
    });
}

export function CitationQuotesSection({
    document,
    quotes: suppliedQuotes,
    error = null,
    isLoading = false,
    activeQuoteId = null,
    currentIndex: suppliedCurrentIndex,
    citationRef,
    onSelect,
    onIndexChange,
    onClose,
}: Props) {
    const quotes = useMemo(
        () =>
            document ? documentQuoteItems(document) : (suppliedQuotes ?? []),
        [document, suppliedQuotes],
    );
    const requestedIndex =
        suppliedCurrentIndex ??
        Math.max(
            0,
            quotes.findIndex((quote) => quote.id === activeQuoteId),
        );
    const currentIndex = Math.min(
        Math.max(requestedIndex, 0),
        Math.max(quotes.length - 1, 0),
    );
    const hasMultipleQuotes = quotes.length > 1;
    const currentQuote = quotes[currentIndex];

    return (
        <div className="px-2 pb-2">
            <div className={`${RESPONSE_GLASS_SURFACE} p-2`}>
                <div className="mb-2 flex items-center justify-between">
                    <ContextNumberBadge number={citationRef} label="Citation" />
                    <div className="ml-auto flex items-center gap-2">
                        {hasMultipleQuotes && (
                            <div className="flex items-center gap-1">
                                <span className="mr-0.5 text-xs font-medium text-gray-500">
                                    Quotes
                                </span>
                                {quotes.map((quote, index) => {
                                    const isUnverified =
                                        quote.verificationState ===
                                        "unverified";
                                    return (
                                        <button
                                            key={quote.id}
                                            type="button"
                                            disabled={isUnverified}
                                            onClick={() =>
                                                !isUnverified &&
                                                onIndexChange?.(index)
                                            }
                                            className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] transition-colors ${
                                                currentIndex === index &&
                                                !isUnverified
                                                    ? "!bg-blue-100 !text-blue-900 font-medium dark:!bg-blue-950 dark:!text-white"
                                                    : isUnverified
                                                      ? "cursor-not-allowed !bg-red-100/85 !text-red-800 dark:!bg-red-950 dark:!text-white"
                                                      : "bg-gray-200/80 text-gray-800 hover:bg-gray-200 hover:text-gray-950"
                                            }`}
                                        >
                                            {index + 1}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
                <div>
                    {isLoading ? (
                        <RelevantQuoteSkeleton />
                    ) : error ? (
                        <RelevantQuoteMessage tone="error">
                            {error}
                        </RelevantQuoteMessage>
                    ) : currentQuote ? (
                        <QuoteItem
                            quote={currentQuote}
                            isActive={activeQuoteId === currentQuote.id}
                            quoteLabel={currentQuote.quoteLabel ?? ""}
                            onView={() =>
                                onSelect?.(currentQuote, currentIndex)
                            }
                            onClose={onClose}
                        />
                    ) : (
                        <RelevantQuoteMessage>
                            No relevant quotes.
                        </RelevantQuoteMessage>
                    )}
                    {onClose && (isLoading || error || !currentQuote) && (
                        <div className="mt-2 flex justify-end">
                            <TextButtonUI size="xs" title="Close citation" onClick={onClose}>Close</TextButtonUI>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

function RelevantQuoteSkeleton() {
    return (
        <TextSlabUI className="animate-pulse">
            <div className="h-3 w-28 rounded bg-gray-200" />
            <div className="mt-2.5 h-3 w-full rounded bg-gray-200" />
            <div className="mt-2 h-3 w-11/12 rounded bg-gray-200" />
            <div className="mt-2 h-3 w-2/3 rounded bg-gray-200" />
        </TextSlabUI>
    );
}

function RelevantQuoteMessage({
    children,
    tone = "neutral",
}: {
    children: ReactNode;
    tone?: "neutral" | "error";
}) {
    return (
        <TextSlabUI>
            <p
                className={`font-serif text-sm leading-6 ${
                    tone === "error" ? "text-red-700" : "text-gray-600"
                }`}
            >
                {children}
            </p>
        </TextSlabUI>
    );
}

function QuoteItem({
    quote,
    isActive,
    quoteLabel,
    onView,
    onClose,
}: {
    quote: CitationQuoteSectionItem;
    isActive: boolean;
    quoteLabel: string;
    onView: () => void;
    onClose?: () => void;
}) {
    const isUnverified = quote.verificationState === "unverified";
    const isSelected = isActive && !isUnverified;

    return (
        <div>
            {/* Long quotes scroll inside the slab so the actions stay in view;
                focusable so the scroll is reachable by keyboard. */}
            <TextSlabUI
                selected={isSelected}
                tabIndex={0}
                className="max-h-40 w-full overflow-y-auto overscroll-contain text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            >
                <div>
                    <p
                        className={`font-serif text-sm leading-6 ${
                            isSelected
                                ? "citation-quote-selected-text"
                                : "text-gray-700"
                        }`}
                    >
                        &ldquo;{quote.quote.replace(/"/g, "'")}&rdquo;
                        {quoteLabel && (
                            <span
                                className={`text-sm ${
                                    isSelected
                                        ? "citation-quote-selected-muted"
                                        : "text-gray-500"
                                }`}
                            >
                                {" "}({quoteLabel})
                            </span>
                        )}
                    </p>
                </div>
            </TextSlabUI>
            <div className="mt-2 flex items-center justify-between gap-2">
                {isUnverified ? (
                    <CitationVerificationBadge state="unverified" />
                ) : (
                    <CiteQuoteButton
                        quoteText={quote.quote}
                        quoteLabel={quoteLabel}
                    />
                )}
                {onClose && (
                    <TextButtonUI size="xs" title="Close citation" onClick={onClose} className="ml-auto">
                        Close
                    </TextButtonUI>
                )}
                <PillButtonUI
                    tone="black"
                    size="xs"
                    disabled={isUnverified}
                    onClick={onView}
                >
                    View
                </PillButtonUI>
            </div>
        </div>
    );
}

/**
 * Copies the quote and its locator to the clipboard, confirming inline for a
 * couple of seconds. Only this section cites a quote, so it lives here rather
 * than in a primitive.
 */
function CiteQuoteButton({
    quoteText,
    quoteLabel,
}: {
    quoteText: string;
    quoteLabel: string;
}) {
    const [isCopied, setIsCopied] = useState(false);
    const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (resetTimer.current) clearTimeout(resetTimer.current);
        },
        [],
    );

    const handleClick = async () => {
        try {
            const label = quoteLabel ? ` (${quoteLabel})` : "";
            await navigator.clipboard.writeText(
                `"${quoteText.replace(/"/g, "'")}"${label}`,
            );
            setIsCopied(true);
            if (resetTimer.current) clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(() => setIsCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy citation:", err);
        }
    };

    return (
        <PillButtonUI
            tone="white"
            size="xs"
            onClick={handleClick}
            title="Copy Quote and Citation"
        >
            {isCopied ? (
                <Check aria-hidden="true" className="h-3 w-3 text-green-600" />
            ) : (
                <QuoteIcon aria-hidden="true" className="h-3 w-3" />
            )}
            {/* The visible label is the accessible name; do not override it. */}
            <span role="status">{isCopied ? "Copied" : "Cite"}</span>
        </PillButtonUI>
    );
}
