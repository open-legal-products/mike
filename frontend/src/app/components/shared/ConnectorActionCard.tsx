"use client";

import type { ConnectorApprovalItem } from "@mike/contracts";
import { ChevronRight } from "lucide-react";

// Readable labels for the argument names Mike's built-in connectors use.
// Anything else (for example an MCP server's own parameters) shows its key.
const labels: Record<string, string> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  body: "Message",
  calendar_id: "Calendar",
  event_id: "Event",
  file_id: "File",
  parent_id: "Destination folder",
  file_type: "File type",
  content: "New contents",
  file: "File",
  destination: "Destination folder",
  name: "Name",
  draft_id: "Draft",
  message_id: "Message",
  summary: "Title",
  description: "Description",
  location: "Location",
  start: "Start",
  end: "End (exclusive for all-day events)",
  attendees: "Attendees",
  add_label_ids: "Add labels",
  remove_label_ids: "Remove labels",
  date: "Date",
  dateTime: "Date and time",
  timeZone: "Time zone",
  email: "Email",
};

function display(value: unknown): string {
  if (Array.isArray(value)) return value.map(display).join("\n");
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([, nested]) => nested !== undefined && nested !== null)
      .map(([key, nested]) => `${labels[key] ?? key}: ${display(nested)}`)
      .join("\n");
  return String(value ?? "");
}

function consequenceNote(item: ConnectorApprovalItem): string | null {
  if (item.tool_name === "google_drive_replace_file_content")
    return "This replaces all file contents with the text shown below. Existing Google Doc formatting is replaced.";
  if (item.tool_name === "google_drive_trash_file")
    return "This moves the item to Google Drive Trash. Trashing a folder affects its contents.";
  if (item.tool_name === "google_drive_move_file")
    return "Moving this item may change access inherited from its folder.";
  if (
    item.binding.type === "google" &&
    item.binding.provider === "google-calendar"
  )
    return "Google will notify attendees of this change. Deleting an event sends cancellation notices.";
  if (item.tool_name === "gmail_delete_draft")
    return "This deletes the draft. Review its contents before approving.";
  return null;
}

/**
 * The exact connector action waiting for approval: what runs, where, and as
 * whom. It renders for Google and MCP connectors alike; decisions are made by
 * the surface around it.
 */
export function ConnectorActionCard({ item }: { item: ConnectorApprovalItem }) {
  const note = consequenceNote(item);
  const args = Object.entries(item.arguments).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  return (
    <article
      aria-label={`${item.title} on ${item.connector_name}`}
      className="space-y-3 text-left"
    >
      <div>
        <h4 className="text-sm font-medium text-gray-900">{item.title}</h4>
        <p className="mt-0.5 text-xs text-gray-500 [overflow-wrap:anywhere]">
          {item.connector_name}
          {item.account ? ` · ${item.account}` : ""}
        </p>
      </div>
      {note && <p className="text-sm text-gray-700">{note}</p>}
      {args.length > 0 ? (
        <dl className="space-y-2 text-sm">
          {args.map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs text-gray-500">{labels[key] ?? key}</dt>
              <dd className="whitespace-pre-wrap text-gray-800 [overflow-wrap:anywhere]">
                {display(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-gray-500">This action takes no details.</p>
      )}
      {item.before !== undefined && (
        <details className="group/approval-details">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded text-xs text-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 group-open/approval-details:rotate-90"
            />
            Current item before this change
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap font-sans text-xs text-gray-700 [overflow-wrap:anywhere]">
            {display(item.before)}
          </pre>
        </details>
      )}
    </article>
  );
}
