import { Children, memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CitationPillUI } from "@mike/ui";

import { cn } from "../lib/utils";

// Hoisted so react-markdown receives referentially stable props — an inline
// plugins array/components object defeats its internal memoization and forces
// a full re-parse of every message on every transcript render.
const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="mb-3 last:mb-0 whitespace-pre-wrap">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-lg font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 list-disc pl-5 space-y-1 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal pl-5 space-y-1 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ children, href }) => {
    // Reserved fragment for document citations (see taskpane/lib/citations):
    // rendered as an in-pane chip, activated via click delegation on the
    // prose container — never a navigation.
    if (href?.startsWith("#mike-cite:")) {
      const label = Children.toArray(children).join("");
      const numberedCitation = label.match(/^\[(\d+)\]$/);
      if (numberedCitation) {
        return (
          <CitationPillUI
            data-mike-citation=""
            data-citation-href={href}
            title="Show in the document"
            aria-label={`Citation ${numberedCitation[1]}`}
            className="mx-0.5 align-super"
          >
            {numberedCitation[1]}
          </CitationPillUI>
        );
      }
      return (
        <a
          href={href}
          data-mike-citation=""
          title="Show in the document"
          className="mx-0.5 inline-flex max-w-full cursor-pointer items-baseline rounded-md border border-gray-200 bg-gray-50 px-1.5 py-0.5 align-baseline font-sans text-[0.85em] not-italic text-gray-600 no-underline transition-colors hover:border-gray-300 hover:bg-gray-100 hover:text-gray-900"
        >
          <span className="truncate">{children}</span>
        </a>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 underline underline-offset-2 hover:text-blue-700"
      >
        {children}
      </a>
    );
  },
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-gray-300 pl-3 text-gray-600 italic last:mb-0">
      {children}
    </blockquote>
  ),
  code: ({ className: codeClass, children }) => {
    const isBlock = (codeClass ?? "").includes("language-");
    if (isBlock) {
      return (
        <code className="block overflow-x-auto rounded-md bg-gray-100 p-3 font-mono text-xs text-gray-800">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.85em] text-gray-800">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="mb-3 last:mb-0">{children}</pre>,
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-gray-200 bg-gray-50 px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-gray-200 px-2 py-1">{children}</td>
  ),
  hr: () => <hr className="my-3 border-gray-200" />,
};

/**
 * Markdown renderer for the Word add-in's chat content. A trimmed,
 * dependency-light adaptation of the web assistant's renderer
 * (frontend/src/app/components/assistant/message/MarkdownContent.tsx:
 * react-markdown + remark-gfm) with explicit element styling instead of the
 * Tailwind typography plugin, and without the web's math/citation handling.
 * Memoized: parsing is linear in the answer's length, so settled messages
 * must not re-parse when the transcript re-renders around them.
 */
export const Markdown = memo(function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-sm leading-relaxed text-gray-900 break-words",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
