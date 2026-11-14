import type { AssistantEvent } from "../../shared/types";
import type { McpSourceLink } from "@mike/contracts";
import { parseMcpSourceLinks } from "@/app/lib/mcpSourceLinks";

export function SourceLinksBlock({ events, isStreaming }: { events: AssistantEvent[]; isStreaming?: boolean }) {
    const links: McpSourceLink[] = [];
    let counterpediaCall = false;
    for (const event of events) {
        if (event.type !== "mcp_tool_call") continue;
        if (event.tool_name.startsWith("counterpedia.") || event.openai_tool_name.includes("counterpedia")) counterpediaCall = true;
        if (event.tool_name !== "counterpedia.get_source_presence") continue;
        if (event.status !== "ok" || event.isStreaming || ("interrupted" in event && event.interrupted === true)) continue;
        for (const value of parseMcpSourceLinks(event.source_links)) {
            if (!links.some((link) => link.source_id === value.source_id && link.url === value.url)) {
                links.push(value);
            }
        }
    }
    if (isStreaming || (!links.length && !counterpediaCall)) return null;
    return (
        <section className="mt-3 mb-3 font-sans" aria-label="Source links">
            <h3 className="text-sm font-semibold text-gray-700">Source links</h3>
            {links.length ? (
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                    {links.map((link) => (
                        <li key={`${link.source_id}:${link.url}`} className="[overflow-wrap:anywhere]">
                            <a
                                href={link.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 underline hover:text-blue-700"
                            >
                                {link.label}
                            </a>{" "}
                            <span className="text-gray-500">({link.source_id})</span>
                            <span className="ml-1 text-gray-500">
                                {link.basis === "capture_observation"
                                    ? "Recorded capture origin; current access not established."
                                    : "Discovered source; current access not established."}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="mt-1 text-sm text-gray-500">Source link not established.</p>
            )}
        </section>
    );
}
