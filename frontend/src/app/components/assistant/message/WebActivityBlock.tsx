import { useState, type ReactNode } from "react";
import type { WebSource } from "@mike/contracts";
import { WebSkeuoIcon } from "@/app/components/shared/WebSkeuoIcon";
import type { AssistantEvent } from "../../shared/types";
import { EventBlock } from "./EventBlocks";
import { EventDisclosureButton, EventLabel } from "./EventDisclosure";

type WebSearchEvent = Extract<AssistantEvent, { type: "web_search" }>;
type WebReadEvent = Extract<AssistantEvent, { type: "web_read" }>;

function webAddress(url: string): { href: string | null; host: string } {
    // URL.canParse is missing from Safari before 17.
    let parsed: URL | null = null;
    try {
        parsed = new URL(url);
    } catch {
        parsed = null;
    }
    if (parsed?.protocol === "http:" || parsed?.protocol === "https:") {
        return {
            href: parsed.href,
            host: parsed.hostname.replace(/^www\./, ""),
        };
    }
    return { href: null, host: url };
}

function WebPageName({
    source,
    linked = true,
}: {
    source: WebSource;
    linked?: boolean;
}) {
    const { href, host } = webAddress(source.url);
    const title = source.title?.trim();
    const name = title ? (
        <>
            {title} <span className="text-gray-400">{host}</span>
        </>
    ) : (
        host
    );
    if (!href || !linked) {
        return <span className="[overflow-wrap:anywhere]">{name}</span>;
    }
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="[overflow-wrap:anywhere] hover:text-gray-700 hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
        >
            {name}
        </a>
    );
}

// Flat grey pills. A long page title wraps inside its pill rather than being
// cut off.
const WEB_PAGE_TEXT_PILL_CLASS =
    "inline-flex min-h-6 max-w-full items-center rounded-full bg-gray-100 px-2.5 py-1 text-left text-[11px] font-medium leading-snug text-gray-700 [overflow-wrap:anywhere]";
const WEB_PAGE_LINK_PILL_CLASS = `${WEB_PAGE_TEXT_PILL_CLASS} transition-colors hover:bg-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40`;

function WebPagePill({ source }: { source: WebSource }) {
    const { href, host } = webAddress(source.url);
    const title = source.title?.trim();
    const name = (
        <span className="min-w-0">
            {title ? (
                <>
                    {title}{" "}
                    <span className="font-normal text-gray-400">{host}</span>
                </>
            ) : (
                host
            )}
        </span>
    );
    if (!href) return <span className={WEB_PAGE_TEXT_PILL_CLASS}>{name}</span>;
    return (
        <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={WEB_PAGE_LINK_PILL_CLASS}
        >
            {name}
        </a>
    );
}

function WebPageList({ sources }: { sources: WebSource[] }) {
    return (
        <ul className="mt-2 flex flex-wrap gap-1.5">
            {sources.map((source, index) => (
                <li key={`${index}-${source.url}`} className="flex max-w-full">
                    <WebPagePill source={source} />
                </li>
            ))}
        </ul>
    );
}

/** The globe and label at the start of a web search or page read. */
function WebEventLabel({ children }: { children: ReactNode }) {
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <WebSkeuoIcon
                data-testid="web-event-icon"
                className="h-3.5 w-3.5 shrink-0"
            />
            <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        </span>
    );
}

function WebToolError({ message }: { message?: string }) {
    return message ? (
        <p className="mt-0.5 text-xs text-red-600">{message}</p>
    ) : null;
}

export function WebSearchBlock({
    event,
    isStreaming,
    interrupted,
    showConnector,
}: {
    event: WebSearchEvent;
    isStreaming?: boolean;
    /** The turn ended before the search reported its results. */
    interrupted?: boolean;
    showConnector?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const query = event.query.trim();
    const forQuery = query ? <> for &ldquo;{query}&rdquo;</> : null;
    const error = event.error;
    const label: ReactNode = isStreaming ? (
        <>Searching the web{forQuery}</>
    ) : interrupted ? (
        <>Web search stopped{forQuery}</>
    ) : error ? (
        query ? <>Web search failed{forQuery}</> : "Web search unavailable"
    ) : (
        <>Searched the web{forQuery}</>
    );
    const results = event.results;

    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={error ? "red" : results.length ? "green" : "gray"}
        >
            {results.length ? (
                <EventDisclosureButton
                    open={open}
                    onToggle={() => setOpen((value) => !value)}
                    label={<WebEventLabel>{label}</WebEventLabel>}
                />
            ) : (
                <WebEventLabel>
                    <EventLabel>{label}</EventLabel>
                    {isStreaming ? <span>...</span> : null}
                </WebEventLabel>
            )}
            <WebToolError message={error} />
            {open && results.length > 0 && <WebPageList sources={results} />}
        </EventBlock>
    );
}

export function WebReadBlock({
    event,
    isStreaming,
    interrupted,
    showConnector,
}: {
    event: WebReadEvent;
    isStreaming?: boolean;
    /** The turn ended before the read reported its result. */
    interrupted?: boolean;
    showConnector?: boolean;
}) {
    const error = event.error;
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={error ? "red" : interrupted ? "gray" : "green"}
        >
            <WebEventLabel>
                <EventLabel>
                    {isStreaming
                        ? "Reading"
                        : error
                          ? "Read failed"
                          : interrupted
                            ? "Read stopped"
                            : "Read"}
                </EventLabel>{" "}
                {/* Only a page the server actually read is a link: the model
                    picks the URL, and it may not be one the user should open. */}
                <WebPageName
                    source={event}
                    linked={!isStreaming && !error && !interrupted}
                />
                {isStreaming ? <span>...</span> : null}
            </WebEventLabel>
            <WebToolError message={error} />
        </EventBlock>
    );
}
