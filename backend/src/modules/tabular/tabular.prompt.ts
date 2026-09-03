// Prompt construction for the tabular-review module: the per-format suffixes
// appended to each column's instruction at extraction time, and the LLM call
// behind POST /tabular-review/prompt that drafts a column's prompt from its
// title.

import { completeText } from "../../lib/llm";
import { getUserModelSettings } from "../user/user.service";
import { failure } from "../../lib/serviceResult";
import { statusFailure, type TabularResult } from "./tabular.shared";

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

export function formatPromptSuffix(format?: string, tags?: string[]): string {
    switch (format) {
        case "bulleted_list":
            return ' The "summary" field in your JSON response must be a markdown bulleted list only — no prose. Format: each item on its own line, prefixed with "* " (asterisk + single space), e.g.\n* First item\n* Second item\n* Third item';
        case "number":
            return ' The "summary" field in your JSON response must be a single number only. No units or explanation.';
        case "percentage":
            return ' The "summary" field in your JSON response must be a single percentage value only (e.g. 42%). No explanation.';
        case "monetary_amount":
            return ' The "summary" field in your JSON response must be the monetary value only, including currency symbol (e.g. $1,234.56). No explanation.';
        case "currency":
            return ' The "summary" field in your JSON response must contain only the currency code(s). Wrap each code in double square brackets, e.g. [[USD]] or [[EUR]]. No other text.';
        case "yes_no":
            return ' The "summary" field in your JSON response must be [[Yes]] or [[No]] only. The "reasoning" field MUST include an inline citation [[document:SOURCE_DOCUMENT_ID||page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the Yes/No answer.';
        case "date":
            return ' The "summary" field in your JSON response must be the date only in DD Month YYYY format (e.g. 1 January 2024). If a range, give both dates separated by an em dash. The "reasoning" field MUST include an inline citation [[document:SOURCE_DOCUMENT_ID||page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact place in the document where the date is found.';
        case "tag":
            return tags?.length
                ? ` The \"summary\" field in your JSON response must contain exactly one tag wrapped in double square brackets. Available tags: ${tags.map((t) => `[[${t}]]`).join(", ")}. No other text. The \"reasoning\" field MUST include an inline citation [[document:SOURCE_DOCUMENT_ID||page:N||quote:verbatim excerpt ≤25 words]] pointing to the exact language in the document that supports the chosen tag.`
                : "";
        default:
            return "";
    }
}

// ---------------------------------------------------------------------------
// Column prompt drafting (POST /tabular-review/prompt)
// ---------------------------------------------------------------------------

export type DraftedColumnPrompt = { prompt: string; source: "llm" };

/**
 * Draft an extraction prompt for a column from its title (plus the format and
 * tags the column will be rendered with, so the model knows what it is writing
 * for — though the prompt itself must never restate the format, which the
 * suffixes above apply separately).
 *
 * Every LLM-side failure — a provider error, unparseable JSON, an empty
 * prompt — is a 502: the request was well-formed and the dependency did not
 * deliver.
 */
export async function draftColumnPrompt(args: {
    userId: string;
    title: string;
    format: string;
    documentName: string;
    tags: string[];
}): Promise<TabularResult<DraftedColumnPrompt>> {
    const { userId, title, format, documentName, tags } = args;

    if (!title) return failure("validation", "title is required");

    const formatDescriptions: Record<string, string> = {
        text: "free-form text",
        bulleted_list: "a bulleted list",
        number: "a single number",
        percentage: "a percentage value",
        monetary_amount: "a monetary amount",
        currency: "a currency code",
        yes_no: "Yes or No",
        date: "a date",
        tag: tags.length ? `one of these tags: ${tags.join(", ")}` : "a tag",
    };
    const formatHint = formatDescriptions[format] ?? "free-form text";
    const tagsNote =
        format === "tag" && tags.length
            ? `\nAvailable tags: ${tags.join(", ")}`
            : "";
    const docNote = documentName ? `\nDocument type/name: ${documentName}` : "";

    const userMessage =
        `Column title: ${title}` +
        docNote +
        `\nExpected response format: ${formatHint}` +
        tagsNote +
        `\n\nWrite the best extraction prompt for a legal tabular review column with this title. ` +
        `Do NOT include any instruction about the response format in the prompt — ` +
        `format handling is applied separately and must not be duplicated inside the prompt text.`;

    try {
        const { tabular_model: promptModel, api_keys } =
            await getUserModelSettings(userId);
        if (!promptModel) {
            return statusFailure(409, {
                code: "model_required",
                detail: "Select a default tabular review model in Settings → Model Preferences before generating a column prompt.",
            });
        }
        const raw = await completeText({
            model: promptModel,
            systemPrompt:
                'You write high-quality column prompts for legal tabular review workflows. Return only valid JSON with a single field: {"prompt": string}. The prompt you write must focus solely on what to extract — never on how to format the response.',
            user: userMessage,
            maxTokens: 512,
            apiKeys: api_keys,
        });
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as { prompt?: unknown };
        if (typeof parsed.prompt === "string" && parsed.prompt.trim()) {
            return {
                ok: true,
                data: { prompt: parsed.prompt.trim(), source: "llm" },
            };
        }
        return statusFailure(502, { detail: "LLM returned an empty prompt" });
    } catch {
        return statusFailure(502, {
            detail: "Failed to generate prompt from LLM",
        });
    }
}
