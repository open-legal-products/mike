import type { Db } from "../../lib/supabase";
import { awsDnsSuffix, bedrockCredentials } from "../../lib/llm/cloudProviders";
import { getUserApiKeys } from "../user/user.service";
import { catalogFailureReason } from "./models.compatible";
import type { CatalogModel, CatalogResult } from "./models.service";

function modelId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 200 && !/\s/.test(value);
}

/** Regional foundation models and account-visible inference profiles. No keys leave the backend. */
export async function listBedrockModels(db: Db, userId: string): Promise<CatalogResult> {
    // Reading the user's keys is Mike's own work: a failure there is an
    // internal error to log, not a provider outage.
    let credentials: ReturnType<typeof bedrockCredentials>;
    try {
        credentials = bedrockCredentials(await getUserApiKeys(userId, db));
    } catch (error) {
        return { ok: false, kind: "error", error };
    }
    if (!credentials) return {
        ok: false, kind: "missing_api_key", code: "missing_api_key",
        detail: "An Amazon Bedrock API key and AWS region are required to list models.",
    };
    const { apiKey, region } = credentials;
    try {
        const base = `https://bedrock.${region}.${awsDnsSuffix(region)}`;
        const signal = AbortSignal.timeout(15_000);
        const read = async (path: string): Promise<Record<string, unknown>> => {
            const response = await fetch(`${base}${path}`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                redirect: "error", signal,
            });
            // Do not retain provider response bodies: they may contain account or credential details.
            if (!response.ok) throw new Error(`Bedrock model catalog request failed (${response.status})`);
            const payload: unknown = await response.json();
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Bedrock catalog response");
            return payload as Record<string, unknown>;
        };
        const models = new Map<string, CatalogModel>();
        const foundation = await read("/foundation-models?byOutputModality=TEXT");
        if (!Array.isArray(foundation.modelSummaries)) throw new Error("Invalid Bedrock foundation model list");
        const textArns = new Set<string>();
        for (const model of foundation.modelSummaries) {
            if (!model || !modelId(model.modelId) || !model.outputModalities?.includes("TEXT") || model.modelLifecycle?.status === "LEGACY") continue;
            if (typeof model.modelArn === "string") textArns.add(model.modelArn);
            if (!model.inferenceTypesSupported?.includes("ON_DEMAND")) continue;
            models.set(model.modelId, { id: model.modelId, label: typeof model.modelName === "string" ? model.modelName : model.modelId });
        }
        let token: string | undefined;
        const seen = new Set<string>();
        do {
            const profiles = await read(`/inference-profiles?maxResults=1000${token ? `&nextToken=${encodeURIComponent(token)}` : ""}`);
            if (!Array.isArray(profiles.inferenceProfileSummaries)) throw new Error("Invalid Bedrock inference profile list");
            for (const profile of profiles.inferenceProfileSummaries) {
                if (!profile || !modelId(profile.inferenceProfileId) || profile.status !== "ACTIVE") continue;
                // Foundation ARNs in cross-region profiles differ only in their region.
                const isText = Array.isArray(profile.models) && profile.models.some((entry: { modelArn?: unknown }) =>
                    typeof entry?.modelArn === "string" && [...textArns].some(arn => arn.split(":foundation-model/")[1] === (entry.modelArn as string).split(":foundation-model/")[1]));
                if (!isText) continue;
                models.set(profile.inferenceProfileId, { id: profile.inferenceProfileId, label: typeof profile.inferenceProfileName === "string" ? profile.inferenceProfileName : profile.inferenceProfileId });
            }
            token = typeof profiles.nextToken === "string" && profiles.nextToken ? profiles.nextToken : undefined;
            if (token && (seen.has(token) || seen.size >= 100)) throw new Error("Invalid Bedrock catalog pagination");
            if (token) seen.add(token);
        } while (token);
        return { ok: true, models: [...models.values()].sort((a, b) => a.label.localeCompare(b.label)) };
    } catch (error) {
        return { ok: false, kind: "upstream", error: new Error(`Amazon Bedrock model catalog could not be loaded: ${catalogFailureReason(error)}`) };
    }
}
