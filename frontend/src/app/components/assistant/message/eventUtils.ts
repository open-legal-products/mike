import type { AssistantEvent } from "../../shared/types";

export function eventErrorMessage(event: AssistantEvent): string | null {
    if (event.type === "error") {
        return event.safe_to_display
            ? event.message
            : "Sorry, something went wrong.";
    }
    if ("error" in event && typeof event.error === "string" && event.error) {
        return "Sorry, something went wrong.";
    }
    return null;
}

/**
 * Label for a connector tool: the connector's own title when it sent one,
 * otherwise its identifier made readable ("get_workspace_teams" becomes
 * "Get workspace teams").
 */
export function connectorToolLabel(
    toolName: string,
    toolTitle?: string | null,
): string {
    const title = toolTitle?.trim();
    if (title) return title;
    const words = toolName.replace(/[_-]+/g, " ").trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : toolName;
}

export function toolCallLabel(name: string): string {
    if (name === "ask_inputs") return "Asking for input...";
    if (name === "generate_docx") return "Creating document...";
    if (name === "generate_excel") return "Creating spreadsheet...";
    if (name === "generate_ppt") return "Creating presentation...";
    if (name === "edit_document") return "Editing document...";
    if (name === "read_document") return "Reading document...";
    if (name === "fetch_documents") return "Reading documents...";
    if (name === "find_in_document") return "Searching document...";
    if (name === "replicate_document") return "Copying document...";
    if (name === "read_workflow") return "Reading workflow...";
    if (name === "list_workflows") return "Loading workflows...";
    if (name === "list_documents") return "Loading documents...";
    if (name === "courtlistener_search_case_law")
        return "Searching case law...";
    if (name === "courtlistener_get_cases") return "Fetching cases...";
    if (name === "courtlistener_find_in_case") return "Searching case...";
    if (name === "courtlistener_read_case") return "Reading case...";
    if (name === "courtlistener_verify_citations")
        return "Verifying citations...";
    if (name.startsWith("mcp_")) return "Using connector...";
    return name ? `Running ${name}...` : "Working...";
}
