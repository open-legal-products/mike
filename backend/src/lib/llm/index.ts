import { completeWithProvider, streamWithProvider } from "./providers";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    return streamWithProvider(params);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    abortSignal?: AbortSignal;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    return completeWithProvider(params);
}
