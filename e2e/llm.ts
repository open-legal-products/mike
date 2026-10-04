/** CI supplies a local Anthropic-protocol fixture; local runs may use a live key. */
export const hasLlmKey = Boolean(process.env.ANTHROPIC_API_KEY);

// A missing fixture must fail CI instead of quietly skipping the chat flows.
if (process.env.CI && (!hasLlmKey || !process.env.ANTHROPIC_BASE_URL)) {
    throw new Error("Web E2E requires its local model fixture and dummy API key in CI.");
}

export const LLM_SKIP_REASON =
    "configure a local model fixture or ANTHROPIC_API_KEY to run chat flows locally";
