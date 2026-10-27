// user code analysis setting — implementation behind the module facade.
//
// Whether the assistant may run Python over the user's documents, from
// Settings > Features. One boolean column, user_profiles.code_analysis, on by
// default; the deployment's CODE_ANALYSIS_ENABLED and the sandbox decide
// whether the tool is available at all.
import { SCHEMA_OUT_OF_DATE_CODE, SCHEMA_OUT_OF_DATE_MESSAGE } from "../../lib/httpError";
import { codeAnalysisEnabled, sandboxCapabilities } from "../../lib/sandbox";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { type Db } from "./user.shared";

const COLUMN = "code_analysis";

export type CodeAnalysisSettings = { enabled: boolean; available: boolean };

/** The column is not there yet: deployed before migrating. */
function isNotMigrated(error: unknown): boolean {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    return (code === "42703" || code === "PGRST204") && typeof message === "string" && message.includes(COLUMN);
}

/** Reads the setting; a database without the column reads as the default, on. */
export async function loadCodeAnalysisSetting(db: Db, userId: string): Promise<boolean> {
    const { data, error } = await db.from("user_profiles").select(COLUMN).eq("user_id", userId).maybeSingle();
    if (error) {
        if (isNotMigrated(error)) return true;
        throw error;
    }
    const value = (data as { code_analysis?: unknown } | null)?.code_analysis;
    return typeof value === "boolean" ? value : true;
}

export async function codeAnalysisAvailable(): Promise<boolean> {
    return codeAnalysisEnabled() && (await sandboxCapabilities()).python;
}

export async function getCodeAnalysisSettings(db: Db, userId: string): Promise<ServiceResult<CodeAnalysisSettings>> {
    try {
        return ok({ enabled: await loadCodeAnalysisSetting(db, userId), available: await codeAnalysisAvailable() });
    } catch (error) {
        return internalFailure(error);
    }
}

export function validateCodeAnalysisPayload(body: unknown): { ok: true; enabled: boolean } | { ok: false; detail: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, detail: "Expected a JSON object" };
    const { enabled } = body as { enabled?: unknown };
    if (typeof enabled !== "boolean") return { ok: false, detail: "enabled must be a boolean" };
    return { ok: true, enabled };
}

export async function saveCodeAnalysisSettings(db: Db, userId: string, enabled: boolean): Promise<ServiceResult<CodeAnalysisSettings>> {
    const { data, error } = await db
        .from("user_profiles")
        .update({ [COLUMN]: enabled })
        .eq("user_id", userId)
        .select(COLUMN)
        .maybeSingle();
    if (error) {
        if (isNotMigrated(error)) return failure("unavailable", SCHEMA_OUT_OF_DATE_MESSAGE, SCHEMA_OUT_OF_DATE_CODE);
        return internalFailure(error);
    }
    if (!data) return failure("not_found", "Profile not found");
    return ok({ enabled, available: await codeAnalysisAvailable() });
}
