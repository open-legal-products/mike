"use client";

import { parseQuotedMessageContent } from "@/app/lib/quotedExcerpts";
import { cn } from "@/app/lib/utils";

interface Props {
    content: string;
    /** Typography for the user's own text; the quotes render one step down. */
    className?: string;
}

/**
 * Renders a sent user message, turning any leading quoted-excerpt block back
 * into styled quotes.
 *
 * The excerpts are stored inside the message content as markdown blockquotes
 * (see `lib/quotedExcerpts`), which keeps the persisted message self-contained
 * — but user messages are rendered as plain text, so without this the reader
 * would see literal `>` characters and the preface line. Messages with no
 * excerpts fall through to exactly the previous rendering.
 */
export function QuotedMessageContent({ content, className }: Props) {
    const { excerpts, body } = parseQuotedMessageContent(content);

    if (excerpts.length === 0) {
        return <p className={cn("whitespace-pre-wrap", className)}>{content}</p>;
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1.5">
                <p className="text-[10px] uppercase tracking-wide text-gray-500">
                    {excerpts.length === 1
                        ? "Quoted from response"
                        : `${excerpts.length} quotes from response`}
                </p>
                {excerpts.map((excerpt, index) => (
                    <blockquote
                        key={`${index}-${excerpt.slice(0, 24)}`}
                        className="border-l-2 border-gray-300 pl-2.5 text-xs italic leading-5 text-gray-600 whitespace-pre-wrap"
                    >
                        {excerpt}
                    </blockquote>
                ))}
            </div>
            {body.length > 0 && (
                <p className={cn("whitespace-pre-wrap", className)}>{body}</p>
            )}
        </div>
    );
}
