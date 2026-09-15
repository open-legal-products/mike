import type { Db } from "./supabase";
import {
    listContentGrants,
    type ContentGrantKind,
} from "./contentAccess";
import { listProjectPeople } from "./projectAccess";

export type ResourcePeopleResult =
    | {
          ok: true;
          scope: "direct" | "project";
          inherited_from_project_id?: string;
          owner: {
              user_id: string;
              email: string | null;
              display_name: string | null;
              role: "owner";
          } | null;
          members: {
              user_id?: string | null;
              email: string;
              display_name: string | null;
              role: "owner" | "editor" | "viewer" | "deny";
          }[];
      }
    | { ok: false; detail: string };

export async function listContentPeople(
    db: Db,
    kind: ContentGrantKind,
    row: {
        id: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
    },
): Promise<ResourcePeopleResult> {
    if (row.project_id) {
        const { data: project, error } = await db
            .from("projects")
            .select("id, user_id, org_id")
            .eq("id", row.project_id)
            .maybeSingle();
        if (error || !project)
            return {
                ok: false,
                detail: error?.message ?? "Parent project not found",
            };
        const people = await listProjectPeople(
            db,
            project as { id: string; user_id: string | null; org_id?: string | null },
        );
        return people.ok
            ? {
                  ...people,
                  scope: "project",
                  inherited_from_project_id: row.project_id,
              }
            : people;
    }

    const listed = await listContentGrants(db, kind, row.id);
    if (!listed.ok) return listed;
    const profileEmails = listed.grants.map((grant) => grant.email);
    const profileIds = row.user_id ? [row.user_id] : [];
    const [{ data: byEmail, error: emailError }, { data: byId, error: idError }] =
        await Promise.all([
            profileEmails.length
                ? db
                      .from("user_profiles")
                      .select("user_id, email, display_name")
                      .in("email", profileEmails)
                : Promise.resolve({ data: [], error: null }),
            profileIds.length
                ? db
                      .from("user_profiles")
                      .select("user_id, email, display_name")
                      .in("user_id", profileIds)
                : Promise.resolve({ data: [], error: null }),
        ]);
    if (emailError || idError)
        return {
            ok: false,
            detail: emailError?.message ?? idError?.message ?? "Failed to load people",
        };
    const profileByEmail = new Map(
        ((byEmail ?? []) as {
            user_id: string;
            email: string;
            display_name: string | null;
        }[]).map((profile) => [profile.email, profile]),
    );
    const creator = (byId?.[0] ?? null) as {
        user_id: string;
        email: string | null;
        display_name: string | null;
    } | null;
    return {
        ok: true,
        scope: "direct",
        owner: creator
            ? { ...creator, role: "owner" }
            : null,
        members: listed.grants.map((grant) => ({
            user_id: profileByEmail.get(grant.email)?.user_id ?? null,
            email: grant.email,
            display_name:
                profileByEmail.get(grant.email)?.display_name ?? null,
            role: grant.role,
        })),
    };
}
