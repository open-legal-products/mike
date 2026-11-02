// An organization's logo: a small image its owners and admins set, shown in
// the sidebar in place of the app's while the organization's workspace is
// active.
//
// Behind the module facade (orgs.service.ts). The image arrives and leaves as
// a data URL. It is stored in org_logos, apart from the organization row, so
// that reading an organization never carries it; organizations.logo_updated_at
// (kept by a database trigger) is what tells a client there is one.

import { recordAudit } from "../../lib/audit";
import { getOrgRole, isOrgAdmin } from "../../lib/access";
import type { OrgResult } from "../../lib/orgs";
import type { Db } from "../../lib/supabase";

import { MAX_PROFILE_IMAGE_BYTES, parseProfileImageDataUrl } from "../../lib/profileImage";

export const MAX_ORG_LOGO_BYTES = MAX_PROFILE_IMAGE_BYTES;
/** Applies shared raster size, encoding, and signature validation with logo-specific error messages. */
export function parseOrgLogoDataUrl(value: unknown) {
    return parseProfileImageDataUrl(value, "logo");
}

/** The organization's logo, for any of its members. */
export async function getOrgLogo(
    db: Db,
    params: { userId: string; orgId: string },
): Promise<OrgResult<{ logo: { data_url: string; updated_at: string } }>> {
    const role = await getOrgRole(params.userId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    const { data, error } = await db
        .from("org_logos")
        .select("content_type, data_base64, updated_at")
        .eq("org_id", params.orgId)
        .maybeSingle();
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    const row = data as {
        content_type?: string;
        data_base64?: string;
        updated_at?: string;
    } | null;
    if (!row?.content_type || !row.data_base64)
        return { ok: false, kind: "not_found" };
    return {
        ok: true,
        logo: {
            data_url: `data:${row.content_type};base64,${row.data_base64}`,
            updated_at: row.updated_at ?? "",
        },
    };
}

/**
 * Set or replace the organization's logo. Owners and admins only: it is how
 * the organization presents itself to every member.
 */
export async function saveOrgLogo(
    db: Db,
    params: {
        actorId: string;
        actorEmail?: string | null;
        orgId: string;
        dataUrl: unknown;
    },
): Promise<OrgResult<{ logo_updated_at: string }>> {
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const parsed = parseOrgLogoDataUrl(params.dataUrl);
    if (!parsed.ok)
        return { ok: false, kind: "validation", detail: parsed.detail };

    const updatedAt = new Date().toISOString();
    const { error } = await db.from("org_logos").upsert(
        {
            org_id: params.orgId,
            content_type: parsed.contentType,
            data_base64: parsed.base64,
            updated_by: params.actorId,
            updated_at: updatedAt,
        },
        { onConflict: "org_id" },
    );
    if (error) return { ok: false, kind: "db_error", detail: error.message };

    await recordAudit(db, {
        userId: params.actorId,
        userEmail: params.actorEmail ?? null,
        action: "org.logo.updated",
        // Never the image itself.
        detail: { org_id: params.orgId, content_type: parsed.contentType },
    });
    return { ok: true, logo_updated_at: updatedAt };
}

/** Remove the organization's logo; the app's own is shown again. */
export async function removeOrgLogo(
    db: Db,
    params: { actorId: string; actorEmail?: string | null; orgId: string },
): Promise<OrgResult<{ logo_updated_at: null }>> {
    const role = await getOrgRole(params.actorId, params.orgId, db);
    if (!role) return { ok: false, kind: "not_found" };
    if (!isOrgAdmin(role)) return { ok: false, kind: "forbidden" };

    const { data, error } = await db
        .from("org_logos")
        .delete()
        .eq("org_id", params.orgId)
        .select("org_id");
    if (error) return { ok: false, kind: "db_error", detail: error.message };
    // Removing a logo that is not there is not worth an audit line.
    if (((data ?? []) as unknown[]).length > 0)
        await recordAudit(db, {
            userId: params.actorId,
            userEmail: params.actorEmail ?? null,
            action: "org.logo.removed",
            detail: { org_id: params.orgId },
        });
    return { ok: true, logo_updated_at: null };
}
