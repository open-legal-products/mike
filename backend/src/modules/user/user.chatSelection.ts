import type { Db } from "../../lib/supabase";
import { getUserModelSettings } from "./user.settings";
import {
  resolveEffectiveChatModel,
  resolveEffectiveReasoningLevel,
} from "../../lib/modelSelection";

/** Shared request → saved chat → profile selection, with no chat mutation.
 * Callers authorize their chat before calling, and own persistence afterwards.
 * In particular Word's local-only mode must not acquire a persistence side effect.
 */
export async function resolveUserChatSelection(
  db: Db,
  args: {
    userId: string;
    requestedModel?: string | null;
    requestedReasoning?: unknown;
    chatModel?: string | null;
    chatReasoningLevel?: unknown;
  },
) {
  const modelSettings = await getUserModelSettings(args.userId, db);
  const resolution = await resolveEffectiveChatModel({
    requested: args.requestedModel,
    chatModel: args.chatModel,
    lastSelectedModel: modelSettings.last_selected_chat_model,
    apiKeys: modelSettings.api_keys,
    userId: args.userId,
    db,
  });
  if (!resolution.ok) return resolution;
  const selectedReasoningLevel = resolveEffectiveReasoningLevel({
    model: resolution.model,
    requested: args.requestedReasoning,
    chatReasoningLevel: args.chatReasoningLevel,
    lastSelectedReasoningLevel: modelSettings.last_selected_reasoning_level,
  });
  return {
    ok: true as const,
    modelSettings,
    selectedModel: resolution.model,
    selectedReasoningLevel,
  };
}
