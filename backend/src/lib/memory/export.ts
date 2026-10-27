import { createHash } from "node:crypto";
import type { Db } from "../supabase";
import { throwIfError } from "../serviceData";
const PAGE_SIZE = 1000;
type ExportWorkspace = string | null;
function inWorkspace(query: any, orgId: ExportWorkspace, column = "org_id") {
    return orgId ? query.eq(column, orgId) : query.is(column, null);
}
export async function selectAll(db: Db, table: string, configure: (query: any) => any, columns = "*"): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let from = 0;; from += PAGE_SIZE) {
        const to = from + PAGE_SIZE - 1;
        const query = configure((db as any)
            .from(table)
            .select(columns)
            .range(from, to));
        const { data, error } = await query;
        await throwIfError(error, `Failed to export ${table}`);
        const batch = (data ?? []) as Record<string, unknown>[];
        rows.push(...batch);
        if (batch.length < PAGE_SIZE)
            break;
    }
    return rows;
}
/**
 * One memory file: a project's, or a person's for one workspace. A person
 * has one per workspace, so the user scope names which (`orgId`, null for
 * Personal) — read unnarrowed, the first of them would stand in for all.
 */
export async function loadMemoryExport(db: Db, scope: "user" | "project", ownerId: string, orgId: ExportWorkspace = null) {
    const ownerColumn = scope === "user" ? "user_id" : "project_id";
    const rows = await selectAll(db, "memory_files", (query) => {
        const owned = query.eq("scope", scope).eq(ownerColumn, ownerId);
        return scope === "user" ? inWorkspace(owned, orgId) : owned;
    }, "id, enabled, epoch, revision, content, content_sha256, size_bytes, status, last_source, updated_by, created_at, updated_at");
    const file = rows[0];
    if (!file) {
        return {
            // Missing state is legacy/corrupt and must never be reported as an
            // implicit opt-in. New owners receive an explicit row at creation.
            enabled: false,
            epoch: 0,
            revision: 0,
            status: "idle",
            created_at: null,
            updated_at: null,
            markdown: "",
            content_sha256: null,
            size_bytes: 0,
            source: null,
            updated_by: null,
        };
    }
    const markdown = typeof file.content === "string" ? file.content : "";
    const storedHash = typeof file.content_sha256 === "string" ? file.content_sha256 : null;
    if (storedHash) {
        const actualHash = createHash("sha256")
            .update(markdown, "utf8")
            .digest("hex");
        if (actualHash !== storedHash) {
            throw new Error("Memory export content checksum mismatch");
        }
    }
    return {
        enabled: file.enabled === true,
        epoch: Number(file.epoch),
        revision: Number(file.revision),
        status: String(file.status ?? "idle"),
        created_at: typeof file.created_at === "string" ? file.created_at : null,
        updated_at: typeof file.updated_at === "string" ? file.updated_at : null,
        markdown,
        content_sha256: storedHash,
        size_bytes: Number(file.size_bytes ?? 0),
        source: typeof file.last_source === "string" ? file.last_source : null,
        updated_by: typeof file.updated_by === "string" ? file.updated_by : null,
    };
}
