// Business logic for the memory module: the per-user and per-project memory
// files that the curator maintains and that people can read, edit, enable,
// disable, or wipe from the settings surfaces.
//
// Service layer behind memory.routes.ts. The storage rules themselves
// (revision fencing, disabled-file guards, size validation) live in
// lib/memory/files because the curator jobs and the chat prompt builders
// share them; this file resolves WHO may touch WHICH file and hands the
// route a context it can act on. It never touches req/res.

import { checkProjectAccess } from "../../lib/access";
import {
    enableMemoryFile,
    ensureMemoryFile,
    getMemoryCurrent,
    wipeMemoryFile,
    writeMemoryFile,
    type MemoryFileRow,
    type MemoryScope,
} from "../../lib/memory/files";
import { can, type Capability } from "../../lib/permissions";
import type { Db } from "../../lib/supabase";

// The error classes are part of this module's contract: the route maps each
// onto a status code, and the tests assert those mappings by class.
export {
    MemoryDisabledError,
    MemoryRevisionConflictError,
    MemoryValidationError,
} from "../../lib/memory/files";

export type MemoryContext = {
    scope: MemoryScope;
    ownerId: string;
    file: MemoryFileRow;
};

export type MemoryContextResult =
    | { ok: true; context: MemoryContext }
    | { ok: false; status: 404 | 403; detail: string };

/** The caller's own app-memory file, created on first touch. */
export async function resolveUserMemoryContext(
    db: Db,
    userId: string,
): Promise<MemoryContext> {
    const file = await ensureMemoryFile(db, "user", userId);
    return { scope: "user", ownerId: userId, file };
}

/**
 * A project's memory file, gated on the caller holding `required` in that
 * project. A project the caller cannot see is reported as missing so the
 * endpoint never doubles as an existence oracle.
 */
export async function resolveProjectMemoryContext(
    db: Db,
    args: {
        projectId: string;
        userId: string;
        userEmail: string | undefined;
        required: Capability;
    },
): Promise<MemoryContextResult> {
    const access = await checkProjectAccess(
        args.projectId,
        args.userId,
        args.userEmail,
        db,
    );
    if (!access.ok) return { ok: false, status: 404, detail: "Project not found" };
    if (!can(access.projectRole, args.required)) {
        return {
            ok: false,
            status: 403,
            detail: "You do not have permission to manage this memory.",
        };
    }
    const file = await ensureMemoryFile(db, "project", args.projectId);
    return {
        ok: true,
        context: { scope: "project", ownerId: args.projectId, file },
    };
}

export async function currentMemory(db: Db, ctx: MemoryContext) {
    return (await getMemoryCurrent(db, ctx.scope, ctx.ownerId)).current;
}

export async function saveMemory(
    db: Db,
    args: {
        ctx: MemoryContext;
        content: string;
        expectedRevision: number;
        updatedBy: string;
    },
) {
    return (
        await writeMemoryFile({
            db,
            file: args.ctx.file,
            content: args.content,
            expectedRevision: args.expectedRevision,
            source: "manual",
            updatedBy: args.updatedBy,
        })
    ).current;
}

export async function setMemoryEnabled(
    db: Db,
    args: { ctx: MemoryContext; enabled: boolean; updatedBy: string },
) {
    return args.enabled
        ? enableMemoryFile(db, args.ctx.file, args.updatedBy)
        : wipeMemoryFile({
              db,
              file: args.ctx.file,
              enabled: false,
              updatedBy: args.updatedBy,
              source: "settings",
          });
}

export async function wipeMemory(
    db: Db,
    args: { ctx: MemoryContext; updatedBy: string },
) {
    return wipeMemoryFile({
        db,
        file: args.ctx.file,
        enabled: null,
        updatedBy: args.updatedBy,
        source: "wipe",
    });
}

export { handleMemoryConsolidation, markMemoryConsolidationFailed } from "./memory.curator";
