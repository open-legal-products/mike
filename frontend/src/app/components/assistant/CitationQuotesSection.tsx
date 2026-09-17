"use client";

import { useMemo, type ReactNode } from "react";
import { CiteButton } from "@/app/components/ui/cite-button";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import type { PanelDocument, PanelDocumentQuote } from "../shared/types";
import {
    CitationVerificationBadge,
    quoteVerificationState,
    type CitationVerificationDisplayState,
} from "./message/citationVerification";
import { ContextNumberBadge } from "./ContextNumberBadge";
import { RESPONSE_GLASS_SURFACE } from "./message/messageStyles";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

export type CitationQuoteSectionItem = {
    id: string;
    quote: string;
    quoteLabel?: string | null;
    verificationState?: CitationVerificationDisplayState;
};

const QUOTE_CARD_SURFACE = "rounded-2xl bg-gray-100";

interface CommonProps {
    error?: string | null;
    isLoading?: boolean;
    activeQuoteId?: string | null;
    citationRef?: number;
    onSelect?: (quote: CitationQuoteSectionItem, index: number) => void;
    onIndexChange?: (index: number) => void;
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
                        {currentQuote?.verificationState === "unverified" && (
                            <CitationVerificationBadge state="unverified" />
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
                        />
                    ) : (
                        <RelevantQuoteMessage>
                            No relevant quotes.
                        </RelevantQuoteMessage>
                    )}
                </div>
            </div>
        </div>
    );
}

function RelevantQuoteSkeleton() {
    return (
        <div className={`animate-pulse px-3 py-2 ${QUOTE_CARD_SURFACE}`}>
            <div className="h-3 w-28 rounded bg-gray-200" />
            <div className="mt-2.5 h-3 w-full rounded bg-gray-200" />
            <div className="mt-2 h-3 w-11/12 rounded bg-gray-200" />
            <div className="mt-2 h-3 w-2/3 rounded bg-gray-200" />
        </div>
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
        <div className={`px-3 py-2 ${QUOTE_CARD_SURFACE}`}>
            <p
                className={`font-serif text-sm leading-6 ${
                    tone === "error" ? "text-red-700" : "text-gray-600"
                }`}
            >
                {children}
            </p>
        </div>
    );
}

function QuoteItem({
    quote,
    isActive,
    quoteLabel,
    onView,
}: {
    quote: CitationQuoteSectionItem;
    isActive: boolean;
    quoteLabel: string;
    onView: () => void;
}) {
    const isUnverified = quote.verificationState === "unverified";
    const isSelected = isActive && !isUnverified;

    return (
        <div>
            <div
                className={`w-full rounded-xl px-3 py-2 text-left ${
                    isSelected
                        ? "citation-quote-selected"
                        : "bg-gray-100"
                }`}
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
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
                <CiteButton
                    quoteText={quote.quote}
                    quoteLabel={quoteLabel}
                    className={`h-6 rounded-full px-2 text-gray-600 ${LIQUID_GLASS_SUBTLE_CLASS} ${LIQUID_GLASS_HOVER_CLASS}`}
                    showText
                />
                <PillButtonUI
                    tone="black"
                    size="sm"
                    disabled={isUnverified}
                    onClick={onView}
                >
                    View
                </PillButtonUI>
            </div>
        </div>
    );
}
