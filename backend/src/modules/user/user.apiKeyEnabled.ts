import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import {
    getApiKeyStatusFor,
    userKeyOwner,
    type ApiKeyOwner,
    type ApiKeyProvider,
    type ApiKeyStatus,
} from "./user.apiKeyStore";

const OWNER_TABLE = {
    user: { table: "user_api_keys", column: "user_id" },
    org: { table: "org_api_keys", column: "org_id" },
} as const;

/** Toggle a saved credential without changing its encrypted value or models. */
export function setApiKeyEnabled(
    db: Db,
    userId: string,
    provider: ApiKeyProvider,
    enabled: boolean,
): Promise<ServiceResult<ApiKeyStatus>> {
    return setApiKeyEnabledFor(db, userKeyOwner(userId), provider, enabled);
}

/** The same toggle, for a person's key or an organization's. */
export async function setApiKeyEnabledFor(
    db: Db,
    owner: ApiKeyOwner,
    provider: ApiKeyProvider,
    enabled: boolean,
): Promise<ServiceResult<ApiKeyStatus>> {
    const { table, column } = OWNER_TABLE[owner.kind];
    try {
        const { data, error } = await db
            .from(table)
            .update({ enabled, updated_at: new Date().toISOString() })
            .eq(column, owner.id)
            .eq("provider", provider)
            .select("provider");
        if (error) return internalFailure(error);
        if (!data?.length)
            return failure(
                "not_found",
                owner.kind === "org"
                    ? "Save an organization key before changing this provider's status."
                    : "Save a personal key before changing this provider's status.",
            );
        return ok(await getApiKeyStatusFor(owner, db));
    } catch (error) {
        return internalFailure(error);
    }
}
