// Queue transport adapter; authorization and artifact creation belong to the workflow.
import type { Db, DbJob } from "../../lib/dbq/types";
import { buildExport } from "../exports/buildExport";
export function handleExportBuild(db: Db, job: DbJob): Promise<Record<string, unknown>> {
    return buildExport(db, { id: job.id, payload: job.payload });
}
