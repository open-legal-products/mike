import { completeText } from "./index";
import { getCommitteeModel } from "./registry";
import type {
  CommitteeModel,
  CompleteTextParams,
  StreamChatParams,
  StreamChatResult,
} from "./types";

// A committee answers one prompt with several models and has a chair
// synthesize their replies. Members run against the ordinary provider layer,
// so a committee can mix hosted and self-hosted models freely.

type CommitteeMemberConfig = CommitteeModel["members"][number];

const CHAIR_INSTRUCTION =
  "You are chairing a legal AI model committee. Synthesize the member analyses into one accurate, concise answer. Resolve disagreements explicitly when they affect the answer. Do not invent citations or facts that are not present in the member analyses.";

const NO_TOOLS_NOTICE =
  "Note: document and case-law tools are not available in committee mode. Answer directly from the conversation context; do not claim to have created, edited, or looked up documents.";

export function isCommitteeId(
  model: string,
  committeeModels: CommitteeModel[] = [],
): boolean {
  return getCommitteeModel(model, committeeModels) !== null;
}

function resolveCommitteeMember(member: CommitteeMemberConfig) {
  if (typeof member === "string") {
    return { model: member, label: member, systemPrompt: "" };
  }
  return {
    model: member.model,
    label: member.label || member.id || member.model,
    systemPrompt: member.systemPrompt || "",
  };
}

export async function completeCommitteeText(
  params: CompleteTextParams,
): Promise<string> {
  const committee = getCommitteeModel(params.model, params.committeeModels);
  if (!committee) throw new Error(`Unknown committee model: ${params.model}`);
  if (committee.chair === params.model) {
    throw new Error(
      `Committee ${params.model} cannot use itself as the chair model.`,
    );
  }

  const stack = params.committeeStack ?? [];
  if (stack.includes(params.model)) {
    throw new Error(
      `Circular committee reference detected: ${[...stack, params.model].join(" -> ")}.`,
    );
  }
  const nextStack = [...stack, params.model];

  const members = committee.members.map(resolveCommitteeMember);
  const selfReferencing = members.find(
    (member) => member.model === params.model,
  );
  if (selfReferencing) {
    throw new Error(
      `Committee ${params.model} cannot include itself as member ${selfReferencing.label}.`,
    );
  }

  // Members are independent, so run them together rather than in sequence —
  // a committee otherwise costs the sum of its members' latency.
  const memberResponses = await Promise.all(
    members.map(async (member) => ({
      member: member.label,
      text: await completeText({
        model: member.model,
        systemPrompt: [params.systemPrompt, member.systemPrompt]
          .filter(Boolean)
          .join("\n\n"),
        user: params.user,
        maxTokens: params.maxTokens,
        apiKeys: params.apiKeys,
        committeeStack: nextStack,
        committeeModels: params.committeeModels,
        abortSignal: params.abortSignal,
      }),
    })),
  );

  return completeText({
    model: committee.chair,
    systemPrompt: [
      CHAIR_INSTRUCTION,
      params.systemPrompt
        ? `The final answer must follow this original system instruction exactly:\n${params.systemPrompt}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    user: [
      `Original user request:\n${params.user}`,
      "Committee member analyses:",
      ...memberResponses.map(
        (response) => `--- ${response.member} ---\n${response.text}`,
      ),
    ].join("\n\n"),
    maxTokens: params.maxTokens,
    apiKeys: params.apiKeys,
    committeeStack: nextStack,
    committeeModels: params.committeeModels,
    abortSignal: params.abortSignal,
  });
}

export async function streamCommitteeChat(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  // Committee mode has no tool-calling loop. When the caller passes tools
  // (the main chat path always does), drop them and say so in the system
  // prompt so the answer does not claim tool work it could not do.
  const systemPrompt = [
    params.systemPrompt,
    params.tools?.length ? NO_TOOLS_NOTICE : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const conversation = params.messages
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");

  const fullText = await completeCommitteeText({
    model: params.model,
    systemPrompt,
    user: conversation,
    maxTokens: 4096,
    apiKeys: params.apiKeys,
    committeeModels: params.committeeModels,
    abortSignal: params.abortSignal,
  });
  params.callbacks?.onContentDelta?.(fullText);
  return { fullText };
}
