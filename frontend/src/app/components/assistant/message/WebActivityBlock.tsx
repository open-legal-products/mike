import { useState, type ReactNode } from "react";
import type { WebSource } from "@mike/contracts";
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

function WebPageList({ sources }: { sources: WebSource[] }) {
    return (
        <ul className="mt-2 flex flex-col gap-1">
            {sources.map((source, index) => (
                <li key={`${index}-${source.url}`}>
                    <WebPageName source={source} />
                </li>
            ))}
        </ul>
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
    showConnector,
}: {
    event: WebSearchEvent;
    isStreaming?: boolean;
    showConnector?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const query = event.query.trim();
    const forQuery = query ? <> for &ldquo;{query}&rdquo;</> : null;
    const error = event.error;
    const label: ReactNode = isStreaming ? (
        <>Searching the web{forQuery}</>
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
                    label={<span className="[overflow-wrap:anywhere]">{label}</span>}
                />
            ) : (
                <>
                    <EventLabel className="[overflow-wrap:anywhere]">{label}</EventLabel>
                    {isStreaming ? <span>...</span> : null}
                </>
            )}
            <WebToolError message={error} />
            {open && results.length > 0 && <WebPageList sources={results} />}
        </EventBlock>
    );
}

export function WebReadBlock({
    event,
    isStreaming,
    showConnector,
}: {
    event: WebReadEvent;
    isStreaming?: boolean;
    showConnector?: boolean;
}) {
    const error = event.error;
    return (
        <EventBlock
            showConnector={showConnector}
            isStreaming={isStreaming}
            dotColor={error ? "red" : "green"}
        >
            <EventLabel>
                {isStreaming ? "Reading" : error ? "Read failed" : "Read"}
            </EventLabel>{" "}
            {/* Only a page the server actually read is a link: the model
                picks the URL, and it may not be one the user should open. */}
            <WebPageName source={event} linked={!isStreaming && !error} />
            {isStreaming ? <span>...</span> : null}
            <WebToolError message={error} />
        </EventBlock>
    );
}

export function WebSourcesBlock({ sources }: { sources: WebSource[] }) {
    const [open, setOpen] = useState(false);
    return (
        <EventBlock>
            <EventDisclosureButton
                open={open}
                onToggle={() => setOpen((value) => !value)}
                label="Sources"
                detail={`${sources.length} ${sources.length === 1 ? "web page" : "web pages"}`}
            />
            {open && <WebPageList sources={sources} />}
        </EventBlock>
    );
}
