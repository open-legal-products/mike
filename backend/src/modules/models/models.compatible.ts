// Catalogs read from an OpenAI-style `GET /models` listing: xAI, and a user's
// own OpenAI-compatible endpoint. No keys leave the backend.

import type { Db } from "../../lib/supabase";
import { customEndpointCredentials } from "../../lib/llm/cloudProviders";
import { guardedFetch } from "../../lib/mcp/client";
import { getUserApiKeys } from "../user/user.service";
import type { CatalogModel, CatalogResult } from "./models.service";

const XAI_BASE_URL = "https://api.x.ai/v1";
// xAI lists its image, video and voice models next to the chat models.
const XAI_NON_CHAT_MODEL_RE = /imag|video|voice|tts|speech/i;

/**
 * Why a catalog request failed, for the server log. The loaders throw plain
 * Errors that carry only a status code or a fixed phrase, never a response
 * body; anything else (a network or DNS failure) is reduced to its error
 * name so a user-supplied URL or key cannot end up in the message.
 */
export function catalogFailureReason(error: unknown): string {
    if (error instanceof Error && error.constructor === Error) {
        return error.message;
    }
    return error instanceof Error ? error.name : "unknown error";
}

/**
 * The usable ids in a `{ data: [{ id }] }` payload. An id is stored verbatim
 * in user_router_models and prefixed with the provider slug to build the
 * app-level model id, so one with whitespace could never round-trip.
 */
function listedModels(payload: unknown): CatalogModel[] {
    const data =
        payload && typeof payload === "object"
            ? (payload as { data?: unknown }).data
            : undefined;
    if (!Array.isArray(data)) throw new Error("Invalid model list");
    const ids = new Set<string>();
    for (const model of data) {
        const id =
            model && typeof model === "object"
                ? (model as { id?: unknown }).id
                : undefined;
        if (typeof id !== "string") continue;
        const trimmed = id.trim();
        if (!trimmed || trimmed.length > 200 || /\s/.test(trimmed)) continue;
        ids.add(trimmed);
    }
    return [...ids]
        .sort((left, right) => left.localeCompare(right))
        .map((id) => ({ id, label: id }));
}

async function readModels(
    doFetch: typeof fetch,
    baseUrl: string,
    apiKey: string,
): Promise<CatalogModel[]> {
    const response = await doFetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
    });
    // Do not retain response bodies: an arbitrary endpoint's error page is
    // not something to log or forward.
    if (!response.ok) {
        throw new Error(`Model list request failed (${response.status})`);
    }
    return listedModels(await response.json());
}

export async function listXaiModels(
    db: Db,
    userId: string,
): Promise<CatalogResult> {
    // Reading the user's keys is Mike's own work: a failure there is an
    // internal error to log, not a provider outage.
    let key: string | undefined;
    try {
        key = (await getUserApiKeys(userId, db)).xai?.trim();
    } catch (error) {
        return { ok: false, kind: "error", error };
    }
    if (!key) {
        return {
            ok: false,
            kind: "missing_api_key",
            code: "missing_api_key",
            detail: "An xAI API key is required to list models.",
        };
    }
    try {
        const models = await readModels(fetch, XAI_BASE_URL, key);
        return {
            ok: true,
            models: models.filter(
                (model) => !XAI_NON_CHAT_MODEL_RE.test(model.id),
            ),
        };
    } catch (error) {
        return {
            ok: false,
            kind: "upstream",
            error: new Error(
                `xAI model catalog could not be loaded: ${catalogFailureReason(error)}`,
            ),
        };
    }
}

/**
 * Models a user's own endpoint reports. The request goes through the guarded
 * fetch, like every other request to a user-supplied URL.
 */
export async function listCustomEndpointModels(
    db: Db,
    userId: string,
): Promise<CatalogResult> {
    let credentials: ReturnType<typeof customEndpointCredentials>;
    try {
        credentials = customEndpointCredentials(
            await getUserApiKeys(userId, db),
        );
    } catch (error) {
        return { ok: false, kind: "error", error };
    }
    if (!credentials) {
        return {
            ok: false,
            kind: "missing_api_key",
            code: "missing_api_key",
            detail: "An API key and base URL are required to list models.",
        };
    }
    try {
        return {
            ok: true,
            models: await readModels(
                guardedFetch,
                credentials.baseUrl,
                credentials.apiKey,
            ),
        };
    } catch (error) {
        return {
            ok: false,
            kind: "upstream",
            error: new Error(
                `The OpenAI-compatible endpoint's model list could not be loaded: ${catalogFailureReason(error)}`,
            ),
        };
    }
}
