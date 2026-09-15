// storageCleanup — implementation behind the module facade.
import { assertStorageConfigured, deleteFile, listFiles } from "../storage";
import { type Db, type DbJob } from "./types";

export async function handleStorageCleanup(db: Db, job: DbJob): Promise<void> {
    const keys = (job.payload.keys as string[] | undefined) ?? [];
    const prefixes = (job.payload.prefixes as string[] | undefined) ?? [];

    if (keys.length > 0 || prefixes.length > 0) assertStorageConfigured();

    const targets = new Set(keys.filter((k) => typeof k === "string" && k));
    for (const prefix of prefixes) {
        if (typeof prefix !== "string" || !prefix) continue;
        for (const key of await listFiles(prefix)) targets.add(key);
    }

    // Delete everything we can this attempt; throw at the end if anything
    // failed so the retry re-runs the (idempotent) remainder.
    let failures = 0;
    for (const key of targets) {
        try {
            await deleteFile(key);
        } catch {
            failures++;
        }
    }
    if (failures > 0) {
        throw new Error(
            `[storage.cleanup] ${failures}/${targets.size} deletes failed`,
        );
    }
}
