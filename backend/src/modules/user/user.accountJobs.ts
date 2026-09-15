// accountJobs — implementation behind the module facade.
import { deleteUserAccountData } from "./user.dataCleanup";
import { deleteFile } from "../../lib/storage";
import { type Db, type DbJob } from "../../lib/dbq/types";

export async function handleAccountDelete(db: Db, job: DbJob): Promise<void> {
    const userId = job.payload.userId as string | undefined;
    if (!userId) return;
    const userEmail = (job.payload.userEmail as string | undefined) ?? null;

    // The whole cascade is deletes — idempotent by nature, so a crash midway
    // simply re-runs. The user's sessions were revoked by the route, so no new
    // data can appear underneath us.
    await deleteUserAccountData(db, userId, userEmail);

    // Erase the user's leftovers in the queue itself: export artifacts hold a
    // full copy of their data, and queued audit payloads hold titles/prompts.
    //
    // FILE BEFORE POINTER, and loudly. result.storage_path on these rows is
    // the only record of where the artifacts live, and the row purge below
    // destroys it. A swallowed storage failure here would let the purge
    // proceed and orphan a full copy of the user's data with nothing left
    // anywhere to retry the delete — so lookup and delete failures throw
    // instead: the job stays retryable (the route enqueues it with
    // maxAttempts 20) and the rows survive until their files are actually
    // gone. deleteUserAccountData already purged the exports/<userId>/
    // prefix with the same throwing semantics; this per-row pass covers
    // listings a storage backend serves stale.
    const { data: exportJobs, error: exportJobsError } = await db
        .from("db_jobs")
        .select("id, result")
        .eq("kind", "export.build")
        .filter("payload->>userId", "eq", userId);
    if (exportJobsError) {
        throw new Error(
            `Failed to load export jobs: ${exportJobsError.message}`,
        );
    }
    const exportRows = (exportJobs ?? []) as Pick<DbJob, "id" | "result">[];
    let artifactFailures = 0;
    for (const row of exportRows) {
        const path = row.result?.storage_path;
        if (typeof path === "string" && path.length > 0) {
            try {
                await deleteFile(path);
            } catch {
                artifactFailures += 1;
            }
        }
    }
    if (artifactFailures > 0) {
        throw new Error(
            `${artifactFailures}/${exportRows.length} export artifact deletes failed`,
        );
    }
    const { data: actorMemoryJobs, error: actorMemoryJobsError } = await db
        .from("db_jobs")
        .select("payload")
        .eq("kind", "memory.consolidate")
        .filter("payload->>actorUserId", "eq", userId);
    if (actorMemoryJobsError) {
        throw new Error("Failed to load account memory jobs");
    }
    const purges = [
        await db
            .from("db_jobs")
            .delete()
            .filter("payload->>userId", "eq", userId)
            .neq("id", job.id),
        await db
            .from("db_jobs")
            .delete()
            .filter("payload->base->>userId", "eq", userId)
            .neq("id", job.id),
        // Memory consolidation payloads intentionally use actorUserId: in a
        // shared project chat the actor is the owner of the app-memory pass.
        // storage.cleanup rows have no actorUserId and must survive erasure so
        // their already-durable object deletion can still complete.
        await db
            .from("db_jobs")
            .delete()
            .eq("kind", "memory.consolidate")
            .filter("payload->>actorUserId", "eq", userId)
            .neq("id", job.id),
    ];
    for (const purge of purges) {
        if (purge.error) {
            throw new Error(
                `Failed to purge queue rows: ${purge.error.message}`,
            );
        }
    }

    // Deleting this actor's queued app pass also removes any project pass it
    // carried. Recompute surviving organization-project status after those
    // rows are gone so their UI cannot remain permanently "scheduled".
    const projectEpochs = new Map<string, number>();
    for (const row of (actorMemoryJobs ?? []) as Array<{
        payload?: Record<string, unknown>;
    }>) {
        const projectId = row.payload?.projectId;
        const epoch = Number(row.payload?.projectEpoch);
        if (
            typeof projectId === "string" &&
            projectId &&
            Number.isSafeInteger(epoch) &&
            epoch >= 0
        ) {
            projectEpochs.set(projectId, epoch);
        }
    }
    for (const [projectId, epoch] of projectEpochs) {
        const { data: file, error: fileError } = await db
            .from("memory_files")
            .select("id")
            .eq("scope", "project")
            .eq("project_id", projectId)
            .eq("epoch", epoch)
            .maybeSingle();
        if (fileError) throw new Error("Failed to refresh project memory status");
        if (!file?.id) continue;
        const { error: refreshError } = await db.rpc(
            "refresh_memory_file_status",
            {
                p_memory_file_id: file.id,
                p_expected_epoch: epoch,
                p_current_job_id: job.id,
                p_requested_status: "idle",
                p_error_code: null,
            },
        );
        if (refreshError) {
            throw new Error("Failed to refresh project memory status");
        }
    }

    // The auth user goes LAST, and only once every row above is gone.
    //
    // The data cascade removes personal content and detaches retained
    // organization content first. Version triggers preserve cleanup intent;
    // only after that work succeeds do we remove the authentication identity.
    const { error } = await db.auth.admin.deleteUser(userId);
    // "not found" is success: a previous attempt got this far before dying.
    if (error && !/not\s*found/i.test(error.message))
        throw new Error(`Failed to delete auth user: ${error.message}`);
}
