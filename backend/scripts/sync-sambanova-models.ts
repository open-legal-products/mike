/**
 * Report drift between the SambaNova catalog hardcoded in
 * src/lib/llm/models.ts and the models the configured account actually serves.
 *
 *   SAMBANOVA_API_KEY=... npx tsx scripts/sync-sambanova-models.ts
 *
 * The tiering (main / mid / low) is a judgement call about where each model
 * belongs, so this script does not rewrite the file: it tells you what changed
 * upstream and leaves the tier assignment to a human.
 */
import {
    SAMBANOVA_LOW_MODELS,
    SAMBANOVA_MAIN_MODELS,
    SAMBANOVA_MID_MODELS,
    sambanovaModelId,
} from "../src/lib/llm/models";

type ServedModel = {
    id: string;
    context_length?: number;
    max_completion_tokens?: number;
};

async function main(): Promise<void> {
    const key = process.env.SAMBANOVA_API_KEY?.trim();
    if (!key) throw new Error("SAMBANOVA_API_KEY is not set.");
    const baseUrl = (
        process.env.SAMBANOVA_BASE_URL?.trim() || "https://api.sambanova.ai/v1"
    ).replace(/\/+$/, "");

    const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) {
        throw new Error(
            `GET ${baseUrl}/models failed: ${response.status} ${response.statusText}`,
        );
    }
    const served = ((await response.json()) as { data: ServedModel[] }).data;
    const servedIds = new Set(served.map((model) => model.id));

    const catalog = new Set(
        [
            ...SAMBANOVA_MAIN_MODELS,
            ...SAMBANOVA_MID_MODELS,
            ...SAMBANOVA_LOW_MODELS,
        ].map(sambanovaModelId),
    );

    console.log(`Served by this account (${served.length}):`);
    for (const model of [...served].sort(
        (a, b) => (b.context_length ?? 0) - (a.context_length ?? 0),
    )) {
        const known = catalog.has(model.id) ? " " : "+";
        console.log(
            `  ${known} ${model.id}  ctx=${model.context_length ?? "?"} max_out=${model.max_completion_tokens ?? "?"}`,
        );
    }

    const retired = [...catalog].filter((id) => !servedIds.has(id));
    const added = [...servedIds].filter((id) => !catalog.has(id));
    if (retired.length)
        console.log(`\nIn our catalog but NO LONGER SERVED: ${retired.join(", ")}`);
    if (added.length) console.log(`\nServed but not in our catalog: ${added.join(", ")}`);
    if (!retired.length && !added.length) console.log("\nCatalog matches the endpoint.");
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
