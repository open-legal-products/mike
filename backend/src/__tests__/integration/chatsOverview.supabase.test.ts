import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DocumentSearchEvent } from "@mike/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAccessibleChat, getChatMessages, leaveChat, listChats } from "../../modules/chat/chat.service";

// Gated: runs only against a real (local) Supabase stack.
//   supabase start, then export:
//     SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY
// or use scripts/test-stack.sh which reads them from `supabase status`.
//
// Pins the email-aware chat overview against creator, direct grant, project,
// and organization access on a real PostgREST stack.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

maybeDescribe("get_chats_overview — role-aware grants", () => {
    let admin: SupabaseClient;
    let callerId = "";
    let callerEmail = "";
    let strangerId = "";

    // One org the caller belongs to, one they do not.
    const sharedOrgId = crypto.randomUUID();
    const foreignOrgId = crypto.randomUUID();

    const myProjectId = crypto.randomUUID();
    const sharedOrgProjectId = crypto.randomUUID();
    const grantedProjectId = crypto.randomUUID();
    const foreignOrgProjectId = crypto.randomUUID();

    // Named by the access branch each one exercises. The first three are
    // visible under BOTH the old and new predicates; the last three are the
    // ones #363 adds (or still denies).
    const chats = {
        mine: crypto.randomUUID(), // branch 1: chat owner
        inMyProject: crypto.randomUUID(), // branch 4: project owner
        inSharedOrgProject: crypto.randomUUID(), // branch 4: project-org member
        inGrantedProject: crypto.randomUUID(), // branch 4: project access grant — NEW
        sharedDirectly: crypto.randomUUID(), // branch 2: chat grant
        strangers: crypto.randomUUID(), // no branch: never visible
    };
    // Widened to string: crypto.randomUUID() is typed as a UUID template
    // literal, which .includes() would then refuse a plain row id against.
    const allChatIds: string[] = Object.values(chats);

    const titlesFrom = (rows: unknown) =>
        (rows as { id: string; title: string }[])
            .filter((r) => allChatIds.includes(r.id))
            .map((r) => r.title)
            .sort();

    beforeAll(async () => {
        admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        callerEmail = `chats-caller-${suffix}@test.local`;
        const caller = await admin.auth.admin.createUser({
            email: callerEmail,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (caller.error || !caller.data.user) {
            throw caller.error ?? new Error("Could not create caller");
        }
        callerId = caller.data.user.id;

        const stranger = await admin.auth.admin.createUser({
            email: `chats-stranger-${suffix}@test.local`,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (stranger.error || !stranger.data.user) {
            throw stranger.error ?? new Error("Could not create stranger");
        }
        strangerId = stranger.data.user.id;

        const orgs = await admin.from("organizations").insert([
            {
                id: sharedOrgId,
                name: `shared-${suffix}`,
                created_by: strangerId,
            },
            {
                id: foreignOrgId,
                name: `foreign-${suffix}`,
                created_by: strangerId,
            },
        ]);
        if (orgs.error) throw orgs.error;

        const members = await admin.from("org_members").insert([
            { org_id: sharedOrgId, user_id: callerId, role: "member" },
            { org_id: sharedOrgId, user_id: strangerId, role: "admin" },
            { org_id: foreignOrgId, user_id: strangerId, role: "admin" },
        ]);
        if (members.error) throw members.error;

        const projects = await admin.from("projects").insert([
            {
                id: myProjectId,
                user_id: callerId,
                name: `mine-${suffix}`,
                visibility: "private",
            },
            {
                id: sharedOrgProjectId,
                user_id: strangerId,
                name: `org-${suffix}`,
                org_id: sharedOrgId,
                visibility: "organization",
            },
            {
                id: grantedProjectId,
                user_id: strangerId,
                name: `granted-${suffix}`,
                visibility: "private",
            },
            {
                id: foreignOrgProjectId,
                user_id: strangerId,
                name: `foreign-${suffix}`,
                org_id: foreignOrgId,
                visibility: "organization",
            },
        ]);
        if (projects.error) throw projects.error;

        // Direct project sharing is a role-carrying grant row.
        const grants = await admin.from("project_access_grants").insert([
            {
                project_id: grantedProjectId,
                email: callerEmail.toLowerCase(),
                role: "editor",
                created_by: strangerId,
            },
        ]);
        if (grants.error) throw grants.error;

        // Keep legacy personal rows with org_id null to exercise their
        // creator/direct-grant access. Organization chats inherit the
        // explicitly public project's visibility.
        const chatRows = await admin.from("chats").insert([
            {
                id: chats.mine,
                project_id: null,
                user_id: callerId,
                title: "mine",
                org_id: null,
            },
            {
                id: chats.inMyProject,
                project_id: myProjectId,
                user_id: strangerId,
                title: "inMyProject",
                org_id: null,
            },
            {
                id: chats.inSharedOrgProject,
                project_id: sharedOrgProjectId,
                user_id: strangerId,
                title: "inSharedOrgProject",
                org_id: sharedOrgId,
            },
            {
                id: chats.inGrantedProject,
                project_id: grantedProjectId,
                user_id: strangerId,
                title: "inGrantedProject",
                org_id: null,
            },
            {
                id: chats.sharedDirectly,
                project_id: null,
                user_id: strangerId,
                title: "sharedDirectly",
                org_id: null,
            },
            {
                id: chats.strangers,
                project_id: foreignOrgProjectId,
                user_id: strangerId,
                title: "strangers",
                org_id: foreignOrgId,
            },
        ]);
        if (chatRows.error) throw chatRows.error;

        const chatGrant = await admin.from("chat_access_grants").insert({
            chat_id: chats.sharedDirectly,
            email: callerEmail.toLowerCase(),
            role: "editor",
            created_by: strangerId,
        });
        if (chatGrant.error) throw chatGrant.error;
    });

    afterAll(async () => {
        if (!admin) return;
        await admin.from("chats").delete().in("id", allChatIds);
        await admin
            .from("projects")
            .delete()
            .in("id", [
                myProjectId,
                sharedOrgProjectId,
                grantedProjectId,
                foreignOrgProjectId,
            ]);
        await admin
            .from("organizations")
            .delete()
            .in("id", [sharedOrgId, foreignOrgId]);
        if (callerId) await admin.auth.admin.deleteUser(callerId);
        if (strangerId) await admin.auth.admin.deleteUser(strangerId);
    });

    it("returns the full email-aware set with effective roles", async () => {
        const current = await admin.rpc("get_chats_overview", {
            p_user_id: callerId,
            p_user_email: callerEmail,
            p_limit: null,
            p_offset: 0,
        });

        expect(current.error).toBeNull();
        expect(titlesFrom(current.data)).toEqual(
            [
                "inGrantedProject",
                "inMyProject",
                "inSharedOrgProject",
                "mine",
                "sharedDirectly",
            ].sort(),
        );
        const row = (current.data as Record<string, unknown>[]).find(
            (r) => r.id === chats.mine,
        );
        expect(row?.is_owner).toBe(true);

        // Every row must also SAY what the caller may do with it. is_owner
        // alone was not enough: the client's roleFrom() falls back to
        // "editor" for any non-owned row without an access_role, so the
        // sidebar offered viewers renames the server refuses and refused
        // admins deletes the server accepts. The role served here is the
        // same verdict the WHERE clause filtered on — one branch each:
        const roleOf = (id: string) =>
            (current.data as Record<string, unknown>[]).find((r) => r.id === id)
                ?.access_role;
        expect(roleOf(chats.mine)).toBe("owner"); // chat creator
        expect(roleOf(chats.inMyProject)).toBe("owner"); // project creator
        expect(roleOf(chats.inSharedOrgProject)).toBe("editor"); // org member
        expect(roleOf(chats.inGrantedProject)).toBe("editor"); // grant role
        expect(roleOf(chats.sharedDirectly)).toBe("editor"); // chat grant
    });

    it("persists message activity and orders refreshed history by it", async () => {
        const staleAt = "2000-01-01T00:00:00.000Z";
        const stale = await admin
            .from("chats")
            .update({ updated_at: staleAt })
            .eq("id", chats.inMyProject);
        if (stale.error) throw stale.error;

        const message = await admin.from("chat_messages").insert({
            chat_id: chats.inMyProject,
            author_user_id: callerId,
            role: "user",
            content: "Most recent message",
        });
        if (message.error) throw message.error;

        const refreshed = await admin.rpc("get_chats_overview", {
            p_user_id: callerId,
            p_user_email: callerEmail,
            p_limit: null,
            p_offset: 0,
        });

        expect(refreshed.error).toBeNull();
        const fixtureRows = (
            refreshed.data as {
                id: string;
                created_at: string;
                updated_at: string;
            }[]
        ).filter((row) => allChatIds.includes(row.id));
        expect(fixtureRows[0]?.id).toBe(chats.inMyProject);
        expect(Date.parse(fixtureRows[0]!.updated_at)).toBeGreaterThan(
            Date.parse(staleAt),
        );
    });

    it("pages with a stable activity cursor without repeating rows", async () => {
        const first = await admin.rpc("get_chats_overview", {
            p_user_id: callerId,
            p_user_email: callerEmail,
            p_limit: 2,
            p_offset: 0,
            p_before_updated_at: null,
            p_before_id: null,
        });
        expect(first.error).toBeNull();
        const firstRows = first.data as { id: string; updated_at: string }[];
        expect(firstRows).toHaveLength(2);

        const cursor = firstRows.at(-1)!;
        const second = await admin.rpc("get_chats_overview", {
            p_user_id: callerId,
            p_user_email: callerEmail,
            p_limit: 2,
            p_offset: 0,
            p_before_updated_at: cursor.updated_at,
            p_before_id: cursor.id,
        });
        expect(second.error).toBeNull();
        const secondRows = second.data as { id: string }[];
        expect(secondRows).toHaveLength(2);
        const firstIds = new Set(firstRows.map((row) => row.id));
        expect(secondRows.some((row) => firstIds.has(row.id))).toBe(false);
    });

    it("clamps and applies paging", async () => {
        const page = await admin.rpc("get_chats_overview", {
            p_user_id: callerId,
            p_user_email: callerEmail,
            p_limit: 1,
            p_offset: 0,
        });
        expect(page.error).toBeNull();
        expect((page.data as unknown[]).length).toBe(1);
    });

    it("retrieves persisted document-search events through the chat history service", async () => {
        const search: DocumentSearchEvent = {
            type: "doc_search", search_id: "persisted-search", scope: "library",
            query: "change of control", offset: 0, match_count: 3, next_offset: null,
        };
        const messageId = crypto.randomUUID();
        const saved = await admin.from("chat_messages").insert({
            id: messageId,
            chat_id: chats.mine,
            role: "assistant",
            content: [search, { type: "content", text: "Found three matching documents." }],
        });
        expect(saved.error).toBeNull();

        const access = await getAccessibleChat(admin, { chatId: chats.mine, userId: callerId, userEmail: callerEmail });
        expect(access.ok).toBe(true);
        const messages = await getChatMessages(admin, chats.mine);
        expect(messages.find((message) => message.id === messageId)?.content).toEqual([
            search,
            { type: "content", text: "Found three matching documents." },
        ]);
    });

    it("leaves a directly shared chat without deleting it, its messages or other access", async () => {
        const message = await admin.from("chat_messages").insert({
            chat_id: chats.sharedDirectly, role: "user", content: "Synthetic shared message", author_user_id: strangerId,
        });
        expect(message.error).toBeNull();
        const args = { chatId: chats.sharedDirectly, userId: callerId, userEmail: callerEmail };
        const before = await listChats(admin, { ...args, limit: null, offset: 0, beforeUpdatedAt: null, beforeId: null });
        expect(before.ok && before.data).toContainEqual(expect.objectContaining({ id: chats.sharedDirectly, can_leave: true }));
        let restoreError: unknown;
        try {
            expect(await leaveChat(admin, args)).toEqual({ ok: true, data: undefined });
            expect(await getAccessibleChat(admin, args)).toEqual({ ok: false });
            const after = await listChats(admin, { ...args, limit: null, offset: 0, beforeUpdatedAt: null, beforeId: null });
            expect(after.ok && after.data).not.toContainEqual(expect.objectContaining({ id: chats.sharedDirectly }));
            const retained = await admin.from("chats").select("id").eq("id", chats.sharedDirectly).single();
            expect(retained.error).toBeNull();
            const messages = await admin.from("chat_messages").select("id").eq("chat_id", chats.sharedDirectly);
            expect(messages.error).toBeNull();
            expect(messages.data).toHaveLength(1);
            const owner = await getAccessibleChat(admin, { chatId: chats.sharedDirectly, userId: strangerId, userEmail: null });
            expect(owner.ok && owner.projectRole).toBe("owner");
            const otherGrant = await admin.from("project_access_grants").select("role").eq("project_id", grantedProjectId).eq("email", callerEmail.toLowerCase()).single();
            expect(otherGrant.error).toBeNull();
            expect(otherGrant.data?.role).toBe("editor");
        } finally {
            try {
                const restored = await admin.from("chat_access_grants").upsert({
                    chat_id: chats.sharedDirectly, email: callerEmail.toLowerCase(), role: "editor", created_by: strangerId,
                }, { onConflict: "chat_id,email" });
                restoreError = restored.error;
            } catch (error) {
                restoreError = error;
            }
        }
        // Reached only when the assertions succeeded; preserve any original failure.
        if (restoreError) throw restoreError;
    });

});
