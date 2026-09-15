import { completeText, type UserApiKeys } from "../../lib/llm";

const TITLE_FALLBACK = "Misc. Query";

function normalizeGeneratedTitle(raw: string): string {
    const title = raw
        .trim()
        .replace(/^["'`]+|["'`.,:;!?]+$/g, "")
        .trim();
    if (!title) return TITLE_FALLBACK;
    return title.slice(0, 80);
}

export async function generateAssistantChatTitle(args: {
    model: string;
    message: string;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const titleText = await completeText({
        model: args.model,
        user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. If there is not enough information to generate a title, return exactly "${TITLE_FALLBACK}". Return only the title, no quotes or punctuation.\n\nMessage: ${args.message.slice(0, 500)}`,
        maxTokens: 64,
        apiKeys: args.apiKeys,
    });
    return normalizeGeneratedTitle(titleText);
}
