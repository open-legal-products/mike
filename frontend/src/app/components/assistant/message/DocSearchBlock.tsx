import { useState } from "react";
import type { DocumentSearchEvent } from "@mike/contracts";
import { EventBlock } from "./EventBlocks";
import { EventDisclosureButton, EventLabel } from "./EventDisclosure";

/** A document search uses the timeline's disclosure and reveals only its match count. */
export function DocSearchBlock({ event, isStreaming, interrupted, showConnector }: {
    event: DocumentSearchEvent;
    isStreaming?: boolean;
    /** The turn ended before the search reported its matches. */
    interrupted?: boolean;
    showConnector?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const scope = new Map([
        ["project", "project documents"], ["library", "the document library"],
        ["templates", "the template library"], ["document", "this document"],
    ]).get(event.scope) ?? "documents";
    const count = event.match_count ?? 0;

    return (
        <EventBlock showConnector={showConnector} isStreaming={isStreaming}
            dotColor={event.error ? "red" : interrupted || count === 0 ? "gray" : "green"}>
            {interrupted ? (
                // No result arrived, so there is no match count to disclose.
                <EventLabel className="[overflow-wrap:anywhere]">
                    Search stopped in {scope} for &ldquo;{event.query}&rdquo;
                </EventLabel>
            ) : (
                <EventDisclosureButton
                    open={open}
                    onToggle={() => setOpen(value => !value)}
                    label={<span className="[overflow-wrap:anywhere]">
                        {isStreaming ? "Searching" : event.error ? "Search failed in" : "Searched"}{" "}
                        {scope} for &ldquo;{event.query}&rdquo;
                    </span>}
                    isStreaming={isStreaming}
                />
            )}
            {open && !isStreaming && !interrupted && (
                <div className="mt-2">
                    {event.error ?? `${count} ${count === 1 ? "match" : "matches"}`}
                </div>
            )}
        </EventBlock>
    );
}
