// review_contract: the Assistant's door into the contracts module.
//
// A Mike workflow is prose plus assets; it cannot name a server function. This
// tool is what lets a "Tinjauan Kontrak" workflow run the real pipeline — the
// active playbook, a `reviews` row, the redline projection — instead of having
// the chat model freestyle findings from read_document. It reaches the
// contracts module only through its facade (see architecture.test.ts).

import {
  createReviewFromDocx,
  executeReview,
  summarizeReviewOutput,
} from "../../../contracts/contracts.service";
import type { Db } from "../../../../lib/supabase";
import { downloadFile } from "../../../../lib/storage";
import { spotlightFilename } from "../contextBuilders";
import { loadCurrentVersionBytes } from "./documentOps";
import { resolveDocLabel, type DocIndex, type DocStore } from "../types";

export const REVIEW_CONTRACT_TOOL_NAME = "review_contract";

export const CONTRACT_DOCUMENT_TYPES = ["PKS", "LOI", "NDA", "Template Klien", "Lainnya"] as const;

export const CONTRACT_REVIEW_TOOLS = [
  {
    type: "function",
    function: {
      name: REVIEW_CONTRACT_TOOL_NAME,
      description:
        "Run the Dash Electric contract review on an attached .docx contract: grades it against the active internal playbook, stores a review the team can triage at the returned workspace_path, and returns a findings digest (risk level, recommendation, red flags with verbatim highlight_text quotes, missing clauses, non-compliant playbook rules). Only .docx files are supported. Takes 1-2 minutes; call it once per document. When you report findings, cite each one with its highlight_text quote against the same doc_id so the reader can open the clause.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: "The attached contract to review (e.g. 'doc-0'). Must be a .docx.",
          },
          client_name: {
            type: "string",
            description: "Counterparty (client) name as written in the contract.",
          },
          document_type: {
            type: "string",
            enum: [...CONTRACT_DOCUMENT_TYPES],
            description: "Contract type. PKS = perjanjian kerja sama (default when unsure).",
          },
          project_context: {
            type: "string",
            description: "Optional business context the user gave (deal size, urgency, history with the client).",
          },
          review_focus: {
            type: "array",
            items: { type: "string" },
            description: "Optional focus areas in Bahasa (e.g. 'Menyeluruh', 'Tanggung jawab', 'Pembayaran'). Defaults to ['Menyeluruh'].",
          },
        },
        required: ["doc_id", "client_name"],
      },
    },
  },
];

export type ContractReviewStartEvent = { type: "contract_review_start"; filename: string };

export type ContractReviewEvent = {
  type: "contract_review";
  review_id: string | null;
  title: string;
  filename: string;
  status: "ai_reviewed" | "failed";
  risk_level: string | null;
  recommendation: string | null;
  workspace_path: string | null;
  error?: string;
};

export function workspacePathFor(reviewId: string): string {
  return `/contracts/${reviewId}`;
}

type Args = {
  doc_id?: unknown;
  client_name?: unknown;
  document_type?: unknown;
  project_context?: unknown;
  review_focus?: unknown;
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function runContractReviewTool(params: {
  args: Record<string, unknown>;
  docStore: DocStore;
  docIndex?: DocIndex;
  userId: string;
  db: Db;
  write: (s: string) => void;
  nonce?: string;
}): Promise<{ content: string; event: ContractReviewEvent | null }> {
  const { docStore, docIndex, userId, db, write, nonce } = params;
  const args = params.args as Args;

  const rawDocId = str(args.doc_id);
  const docId = resolveDocLabel(rawDocId, docStore, docIndex);
  const docInfo = docId ? docStore.get(docId) : undefined;
  if (!docId || !docInfo) {
    return { content: "Document not found.", event: null };
  }
  const filename = docInfo.filename;
  const promptFilename = spotlightFilename(filename, nonce);
  const fileType = docInfo.file_type?.toLowerCase?.() ?? "";
  if (fileType !== "docx" || docInfo.inline_text !== undefined) {
    return {
      content: JSON.stringify({
        error: "unsupported_format",
        detail: `Contract review only accepts .docx files; ${promptFilename} is ${fileType || "of unknown type"}. Ask the user to attach the Word (.docx) version of the contract.`,
      }),
      event: null,
    };
  }
  const clientName = str(args.client_name);
  if (!clientName) {
    return {
      content: JSON.stringify({ error: "missing_client_name", detail: "client_name is required. Ask the user for the counterparty name if it is not in the contract." }),
      event: null,
    };
  }
  const documentType = (CONTRACT_DOCUMENT_TYPES as readonly string[]).includes(str(args.document_type))
    ? str(args.document_type)
    : "PKS";
  const projectContext = str(args.project_context);
  const reviewFocus = Array.isArray(args.review_focus)
    ? (args.review_focus as unknown[]).map(str).filter(Boolean)
    : [];

  const documentId = docIndex?.[docId]?.document_id;
  const versionId = docIndex?.[docId]?.version_id ?? null;
  let bytes: Buffer | null = null;
  if (documentId) {
    const current = await loadCurrentVersionBytes(documentId, db, versionId);
    if (current) bytes = current.bytes;
  }
  if (!bytes) {
    const raw = await downloadFile(docInfo.storage_path);
    if (raw) bytes = Buffer.from(raw);
  }
  if (!bytes) {
    return { content: "Document could not be read.", event: null };
  }

  write(`data: ${JSON.stringify({ type: "contract_review_start", filename } satisfies ContractReviewStartEvent)}\n\n`);

  const failedEvent = (error: string, reviewId: string | null): ContractReviewEvent => ({
    type: "contract_review",
    review_id: reviewId,
    title: filename.replace(/\.(docx|doc)$/i, ""),
    filename,
    status: "failed",
    risk_level: null,
    recommendation: null,
    workspace_path: reviewId ? workspacePathFor(reviewId) : null,
    error,
  });

  const created = await createReviewFromDocx(db, {
    userId,
    buffer: bytes,
    filename,
    client_name: clientName,
    document_type: documentType,
    project_context: projectContext,
    review_focus: reviewFocus.length > 0 ? reviewFocus : ["Menyeluruh"],
  });
  if (!created.ok) {
    const detail = created.kind === "error" ? "Tinjauan gagal dibuat." : created.detail;
    const event = failedEvent(detail, null);
    write(`data: ${JSON.stringify(event)}\n\n`);
    return { content: JSON.stringify({ error: "review_not_created", detail }), event };
  }

  const reviewId = created.data.id;
  const run = await executeReview(db, reviewId, created.data.input);
  if (!run.ok) {
    const detail = run.kind === "error" ? "Tinjauan AI gagal; coba lagi beberapa saat." : run.detail;
    const event = failedEvent(detail, reviewId);
    write(`data: ${JSON.stringify(event)}\n\n`);
    return {
      content: JSON.stringify({ error: "review_failed", detail, review_id: reviewId, workspace_path: workspacePathFor(reviewId) }),
      event,
    };
  }

  const event: ContractReviewEvent = {
    type: "contract_review",
    review_id: reviewId,
    title: filename.replace(/\.(docx|doc)$/i, ""),
    filename,
    status: "ai_reviewed",
    risk_level: run.data.risk_level,
    recommendation: run.data.recommendation,
    workspace_path: workspacePathFor(reviewId),
  };
  write(`data: ${JSON.stringify(event)}\n\n`);

  const summary = summarizeReviewOutput(run.data.ai_output);
  const content = [
    `Contract review stored for ${promptFilename} (doc_id ${docId}). Report the findings below in Bahasa Indonesia; cite each finding with its highlight_text as a verbatim quote from ${docId}. Point the user to workspace_path for triage, feedback, redlines and the negotiation memo.`,
    JSON.stringify({ review_id: reviewId, workspace_path: workspacePathFor(reviewId), doc_id: docId, ...summary }),
  ].join("\n\n");
  return { content, event };
}
