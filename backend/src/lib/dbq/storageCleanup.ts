// storageCleanup — implementation behind the module facade.
import { setOperation } from "../observability/sentry";
import { assertStorageConfigured, deleteFile, listFiles } from "../storage";
import { type Db, type DbJob } from "./types";

export async function handleStorageCleanup(db: Db, job: DbJob): Promise<void> {
    setOperation("storage.cleanup");
    const keys = (job.payload.keys as string[] | undefined) ?? [];
    const prefixes = (job.payload.prefixes as string[] | undefined) ?? [];

    if (keys.length > 0 || prefixes.length > 0) assertStorageConfigured();

    const targets = new Set(keys.filter((k) => typeof k === "string" && k));
    for (const prefix of prefixes) {
        if (typeof prefix !== "string" || !prefix) continue;
        for (const key of await listFiles(prefix)) targets.add(key);
    }

    // Delete everything we can this attempt; throw at the end if anything
    // failed so the retry re-runs the (idempotent) remainder. The first
    // failure travels as the cause: it is a StorageOperationError whose kind,
    // operation and SDK code are what the Sentry boundary reads, and a fresh
    // Error without it reported only "deletes failed".
    let failures = 0;
    let firstFailure: unknown;
    for (const key of targets) {
        try {
            await deleteFile(key);
        } catch (error) {
            failures++;
            firstFailure ??= error;
        }
    }
    if (failures > 0) {
        throw new Error(
            `[storage.cleanup] ${failures}/${targets.size} deletes failed`,
            { cause: firstFailure },
        );
    }
}
