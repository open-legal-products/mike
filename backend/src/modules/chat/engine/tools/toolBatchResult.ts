// What one runToolCalls batch produced. Kept apart from the dispatcher so
// runLLMStream can hold a batch's results even where the dispatcher itself
// is mocked.
import type {
  DocumentSearchEvent,
  TextCardEvent,
} from "@mike/contracts";
import type { McpToolEvent } from "../../../../lib/mcpConnectors";
import type { AskInputsEvent } from "../types";
import type { CaseCitationEvent, CourtlistenerToolEvent } from "./courtlistenerTools";
import type {
  DocCreatedResult,
  DocEditedResult,
  DocReplicatedResult,
} from "./documentOps";

/** What one batch of tool calls produced. */
export type ToolCallBatchResult = {
  toolResults: unknown[];
  docsRead: {
    filename: string;
    document_id?: string;
    version_id?: string | null;
    version_number?: number | null;
  }[];
  docsFound: {
    filename: string;
    document_id?: string;
    version_id?: string | null;
    version_number?: number | null;
    query: string;
    total_matches: number;
  }[];
  docsCreated: DocCreatedResult[];
  documentSearchEvents: DocumentSearchEvent[];
  docsReplicated: DocReplicatedResult[];
  workflowsApplied: { workflow_id: string; title: string }[];
  docsEdited: DocEditedResult[];
  askInputsEvents: AskInputsEvent[];
  textCardEvents: TextCardEvent[];
  courtlistenerEvents: CourtlistenerToolEvent[];
  caseCitationEvents: CaseCitationEvent[];
  mcpEvents: McpToolEvent[];
};

/** An empty result, to pass to `runToolCalls` as its `results` option. */
export function emptyToolCallBatchResult(): ToolCallBatchResult {
  return {
    toolResults: [],
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    documentSearchEvents: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: [],
    textCardEvents: [],
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
  };
}
