import type { Db } from "../../lib/supabase";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { getUserApiKeyStatus, type ApiKeyProvider, type ApiKeyStatus } from "./user.apiKeyStore";

/** Toggle a saved credential without changing its encrypted value or models. */
export async function setApiKeyEnabled(
    db: Db,
    userId: string,
    provider: ApiKeyProvider,
    enabled: boolean,
): Promise<ServiceResult<ApiKeyStatus>> {
    try {
        const { data, error } = await db
            .from("user_api_keys")
            .update({ enabled, updated_at: new Date().toISOString() })
            .eq("user_id", userId)
            .eq("provider", provider)
            .select("provider");
        if (error) return internalFailure(error);
        if (!data?.length) return failure("not_found", "Save a personal key before changing this provider's status.");
        return ok(await getUserApiKeyStatus(userId, db));
    } catch (error) {
        return internalFailure(error);
    }
}
