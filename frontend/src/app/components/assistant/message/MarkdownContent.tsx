import type { RefObject } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type {
    AssistantEvent,
    Citation,
    PanelDocument,
} from "../../shared/types";
import { CitationPillUI } from "@/shared/ui/CitationPillUI";
import { withoutMarkdownNode } from "./messageStyles";
import { citationTooltip } from "./CitationSources";
import {
    citationVerificationAriaLabel,
    citationVerificationPillClassName,
} from "./citationVerification";
import { internalCaseHref } from "./citationUtils";
import { QUOTABLE_ATTRIBUTE } from "@/app/hooks/useQuotableSelection";

export function MarkdownContent({
    text,
    inlineCitationTargets,
    caseCitations,
    caseDocuments,
    activeCitation,
    onCitationClick,
    onCaseClick,
    divRef,
}: {
    text: string;
    inlineCitationTargets: Citation[];
    caseCitations: Map<
        string,
        Extract<AssistantEvent, { type: "case_citation" }>
    >;
    caseDocuments: Map<number, PanelDocument>;
    activeCitation?: Citation | null;
    onCitationClick?: (c: Citation) => void;
    onCaseClick?: (
        c: Extract<AssistantEvent, { type: "case_citation" }>,
    ) => void;
    divRef?: RefObject<HTMLDivElement | null>;
}) {
    function findCaseCitation(href: string) {
        return caseCitations.get(internalCaseHref(href) ?? "");
    }

    return (
        <div
            ref={divRef}
            // Marks this prose as quotable, so highlighting inside it offers
            // "Add to Chat". Deliberately narrower than the whole message:
            // reasoning blocks, edit cards, and the citation list are chrome,
            // not the answer the reader wants to quote back.
            {...{ [QUOTABLE_ATTRIBUTE]: "" }}
            className="text-gray-900 mb-4 text-base prose prose-sm max-w-none font-serif"
        >
            <ReactMarkdown
                remarkPlugins={[
                    [remarkMath, { singleDollarTextMath: false }],
                    remarkGfm,
                ]}
                rehypePlugins={[rehypeKatex]}
                urlTransform={(url) =>
                    /^us-case-\d+$/.test(url) ? url : defaultUrlTransform(url)
                }
                components={{
                    table: (props) => (
                        <div className="overflow-x-auto my-4 rounded-lg">
                            <table
                                className="min-w-full divide-y divide-gray-300 overflow-hidden"
                                {...withoutMarkdownNode(props)}
                            />
                        </div>
                    ),
                    thead: (props) => (
                        <thead
                            className="bg-gray-100"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    tbody: (props) => (
                        <tbody
                            className="divide-y divide-gray-200"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    tr: (props) => <tr {...withoutMarkdownNode(props)} />,
                    th: (props) => (
                        <th
                            className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    td: (props) => (
                        <td
                            className="whitespace-normal px-3 py-4 text-sm text-gray-900"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h1: (props) => (
                        <h1
                            className="mt-6 mb-4 text-3xl font-serif font-semibold"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h2: (props) => (
                        <h2
                            className="mt-5 mb-3 text-2xl font-serif font-semibold"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h3: (props) => (
                        <h3
                            className="text-xl font-semibold mt-4 mb-2"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h4: (props) => (
                        <h4
                            className="text-lg font-semibold mt-4 mb-2"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h5: (props) => (
                        <h5
                            className="text-base font-semibold mt-3 mb-2"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    h6: (props) => (
                        <h6
                            className="text-sm font-semibold mt-3 mb-2"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    p: ({ node, ...props }) => {
                        const parent =
                            node && typeof node === "object" && "parent" in node
                                ? (node as { parent?: { type?: string } })
                                      .parent
                                : undefined;
                        if (parent?.type === "listItem") {
                            return (
                                <p
                                    className="inline leading-7 m-0"
                                    {...props}
                                />
                            );
                        }
                        return <p className="mb-4 leading-7" {...props} />;
                    },
                    ul: (props) => (
                        <ul
                            className="list-disc list-outside mb-4 pl-6"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    ol: (props) => (
                        <ol
                            className="list-decimal list-outside mb-4 pl-6"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    li: (props) => (
                        <li
                            className="mb-2 leading-7"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    strong: (props) => (
                        <strong
                            className="font-semibold"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    em: (props) => (
                        <em
                            className="italic"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    code: (props) => {
                        const { children, ...codeProps } =
                            withoutMarkdownNode(props);
                        const text = String(children);
                        const citMatch = text.match(/^§(\d+)§$/);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const annotation = inlineCitationTargets[idx];
                            if (annotation) {
                                const tooltipText = citationTooltip(annotation);
                                return (
                                    <CitationPillUI
                                        active={activeCitation === annotation}
                                        onClick={() =>
                                            onCitationClick?.(annotation)
                                        }
                                        data-citation-ref={annotation.ref}
                                        className={`${citationVerificationPillClassName(annotation)} mx-0.5 align-super`}
                                        aria-label={citationVerificationAriaLabel(
                                            annotation,
                                        )}
                                        title={tooltipText}
                                    >
                                        {annotation.ref}
                                    </CitationPillUI>
                                );
                            }
                        }
                        return (
                            <code
                                className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-serif"
                                {...codeProps}
                            >
                                {children}
                            </code>
                        );
                    },
                    blockquote: (props) => (
                        <blockquote
                            className="border-l-4 border-gray-300 pl-4 italic my-4"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                    a: (props) => {
                        const { href, children, ...anchorProps } =
                            withoutMarkdownNode(props);
                        if (href) {
                            const isInternalCaseHref = !!internalCaseHref(href);
                            const citation = findCaseCitation(href);
                            if (citation && onCaseClick) {
                                return (
                                    <button
                                        type="button"
                                        onClick={() =>
                                            onCaseClick({
                                                ...citation,
                                                document:
                                                    citation.cluster_id !== null
                                                        ? (caseDocuments.get(
                                                              citation.cluster_id,
                                                          ) ??
                                                          citation.document)
                                                        : citation.document,
                                            })
                                        }
                                        className="text-left text-blue-600 hover:text-blue-700 underline"
                                    >
                                        {children}
                                    </button>
                                );
                            }
                            if (citation) {
                                return (
                                    <a
                                        href={citation.url}
                                        className="text-blue-600 hover:text-blue-700 underline"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        {children}
                                    </a>
                                );
                            }
                            if (isInternalCaseHref) {
                                return (
                                    <span className="text-blue-600 underline">
                                        {children}
                                    </span>
                                );
                            }
                            return (
                                <a
                                    href={href}
                                    className="text-blue-600 hover:text-blue-700 underline"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    {...anchorProps}
                                >
                                    {children}
                                </a>
                            );
                        }
                        return (
                            <a
                                href={href}
                                className="text-blue-600 hover:text-blue-700 underline"
                                target="_blank"
                                rel="noopener noreferrer"
                                {...anchorProps}
                            >
                                {children}
                            </a>
                        );
                    },
                    hr: (props) => (
                        <hr
                            className="my-6 border-gray-200"
                            {...withoutMarkdownNode(props)}
                        />
                    ),
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
}
