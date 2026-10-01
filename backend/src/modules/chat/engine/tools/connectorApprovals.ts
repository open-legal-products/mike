// Connector write approvals inside the assistant turn.
//
// A connector whose "Ask for permission for write actions" setting is on does
// not run a write tool when the model calls it. The dispatcher turns the call
// into an `approval` item on an ask_inputs event and the turn pauses, exactly
// like a question. The user's decision arrives as an ask_inputs_response; the
// same one-step append that makes answers single-use records it, and only
// after that append succeeds does `runApprovedConnectorActions` run the
// approved items — from the persisted event, never from the client — and
// append their results to the same assistant message.
import type {
  AskInputsEvent,
  AskInputResponseItem,
  ConnectorApprovalItem,
  McpToolEvent,
} from "@mike/contracts";
import type { Db } from "../../../../lib/supabase";
import {
  planGoogleDriveCall,
  executeApprovedGoogleDriveCall,
} from "../../../../lib/integrations/googleDrive";
import {
  executeApprovedMcpToolCall,
  planMcpToolCall,
} from "../../../../lib/mcpConnectors";
import {
  executeApprovedGoogleWorkspaceCall,
  isGoogleWorkspaceTool,
  planGoogleWorkspaceCall,
} from "../../../../lib/integrations/googleWorkspace";
import {
  appendAssistantEventsToMessage,
  loadAssistantMessage,
} from "../contextBuilders";

/** Tool output replayed to the model after an approved call, per call. */
export const MAX_APPROVAL_RESULT_CHARS = 4_000;

export type ConnectorCallPlan =
  | { type: "run" }
  | { type: "approval"; item: Omit<ConnectorApprovalItem, "id"> }
  | { type: "result"; content: string; event: McpToolEvent };

/** All writable connectors share the same assistant approval flow. */
export async function planConnectorToolCall(
  userId: string,
  name: string,
  args: Record<string, unknown>,
  db: Db,
): Promise<ConnectorCallPlan> {
  if (name.startsWith("google_drive_"))
    return planGoogleDriveCall(userId, name, args, db);
  if (isGoogleWorkspaceTool(name))
    return planGoogleWorkspaceCall(userId, name, args, db);
  if (name.startsWith("mcp_")) return planMcpToolCall(userId, name, args, db);
  return { type: "run" };
}

export const APPROVAL_UNAVAILABLE_MESSAGE =
  'This connector asks for permission before write actions, and approvals are only available in the Mike assistant. Tell the user to run this from the Mike assistant, or to turn off "Ask for permission for write actions" for this connector in Settings → Connectors.';

function isApprovalItem(
  item: AskInputsEvent["items"][number],
): item is ConnectorApprovalItem {
  return item.kind === "approval";
}

/**
 * Runs the items the user approved in a just-appended ask_inputs_response and
 * appends their results. Call only after the append reported "appended": that
 * append is what guarantees each approval runs at most once.
 */
export async function runApprovedConnectorActions(args: {
  db: Db;
  chatId: string;
  messageId: string;
  askEventId: string;
  userId: string;
}): Promise<McpToolEvent[]> {
  const { db, chatId, messageId, askEventId, userId } = args;
  const row = await loadAssistantMessage(db, chatId, messageId);
  const content = Array.isArray(row?.content)
    ? (row.content as Record<string, unknown>[])
    : [];
  const ask = content.find(
    (event) => event?.type === "ask_inputs" && event.event_id === askEventId,
  ) as AskInputsEvent | undefined;
  const response = content.find(
    (event) =>
      event?.type === "ask_inputs_response" &&
      event.ask_event_id === askEventId,
  ) as { responses?: AskInputResponseItem[] } | undefined;
  if (!ask || !response?.responses) return [];

  const approved = new Set(
    response.responses
      .filter((item) => item.kind === "approval" && item.decision === "approve")
      .map((item) => item.id),
  );
  const events: McpToolEvent[] = [];
  for (const item of ask.items.filter(isApprovalItem)) {
    if (!approved.has(item.id)) continue;
    const { content: result, event } =
      item.binding.type === "google"
        ? item.binding.provider === "google-drive"
          ? await executeApprovedGoogleDriveCall(userId, item, db)
          : await executeApprovedGoogleWorkspaceCall(userId, item, db)
        : await executeApprovedMcpToolCall(userId, item, db);
    events.push({
      ...event,
      approval_id: item.id,
      result: result.slice(0, MAX_APPROVAL_RESULT_CHARS),
    });
  }
  if (events.length) {
    await appendAssistantEventsToMessage(
      db,
      chatId,
      messageId,
      userId,
      events,
      undefined,
    );
  }
  return events;
}

/** Streams approved-action results the same way live connector calls stream. */
export function writeApprovedConnectorFrames(
  write: (chunk: string) => void,
  events: McpToolEvent[],
) {
  for (const event of events) {
    write(
      `data: ${JSON.stringify({ type: "mcp_tool_start", name: event.openai_tool_name })}\n\n`,
    );
    write(
      `data: ${JSON.stringify({
        type: "mcp_tool_result",
        name: event.openai_tool_name,
        connector_name: event.connector_name,
        tool_name: event.tool_name,
        status: event.status,
        error: event.error,
        approval_id: event.approval_id,
      })}\n\n`,
    );
  }
}
