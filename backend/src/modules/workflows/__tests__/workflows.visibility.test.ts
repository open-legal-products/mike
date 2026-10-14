import { describe, expect, it } from "vitest";
import { createWorkflow, updateWorkflow } from "../workflows.crud";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

// An organization's workflow is private until its creator shares it or opens
// it to the whole organization. A personal workflow can never be opened to
// one. These pin the create and update halves of that setting.

const ORG = "org-1";
const base = { userId: "u1", title: "Disclosure", type: "assistant" as const };
const inserted = (overrides: Record<string, unknown> = {}) => ({
    id: "w1",
    user_id: "u1",
    title: "Disclosure",
    type: "assistant",
    ...overrides,
});

describe("createWorkflow visibility", () => {
    it("creates an organization's workflow private by default", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: { role: "member" } },
            { table: "organizations", data: { kind: "team" } },
            {
                table: "workflows",
                op: "insert",
                data: inserted({ org_id: ORG, visibility: "private" }),
            },
        ]);
        const result = await createWorkflow(fake.db, { ...base, org_id: ORG });

        expect(fake.calls[2].payload).toMatchObject({
            org_id: ORG,
            visibility: "private",
        });
        // Belonging to an organization is not being shared with it.
        expect(result).toMatchObject({
            ok: true,
            workflow: { access_scope: "private" },
        });
        fake.done();
    });

    it("opens it to the organization when its creator asks", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: { role: "member" } },
            { table: "organizations", data: { kind: "team" } },
            {
                table: "workflows",
                op: "insert",
                data: inserted({ org_id: ORG, visibility: "organization" }),
            },
        ]);
        const result = await createWorkflow(fake.db, {
            ...base,
            org_id: ORG,
            visibility: "organization",
        });

        expect(fake.calls[2].payload).toMatchObject({
            visibility: "organization",
        });
        expect(result).toMatchObject({
            ok: true,
            workflow: { access_scope: "organization" },
        });
        fake.done();
    });

    it("refuses to open a personal workflow to an organization, before writing anything", async () => {
        const fake = scriptedDb([]);
        await expect(
            createWorkflow(fake.db, { ...base, visibility: "organization" }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        fake.done();
    });

    it("refuses the caller's own personal organization named by id, before writing anything", async () => {
        // Personal work is made by naming no organization. The organization
        // behind it answers as one the caller is not in.
        const fake = scriptedDb([
            { table: "org_members", data: { role: "owner" } },
            { table: "organizations", data: { kind: "personal" } },
        ]);
        await expect(
            createWorkflow(fake.db, { ...base, org_id: ORG }),
        ).resolves.toEqual({
            ok: false,
            kind: "validation",
            detail: "You are not a member of that organization.",
        });
        fake.done();
    });

    it("refuses a visibility that is not one of the two", async () => {
        const fake = scriptedDb([
            { table: "org_members", data: { role: "member" } },
            { table: "organizations", data: { kind: "team" } },
        ]);
        await expect(
            createWorkflow(fake.db, {
                ...base,
                org_id: ORG,
                visibility: "everyone",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        fake.done();
    });
});

describe("updateWorkflow visibility", () => {
    // The workflow row, then the access check's own read of it, then the
    // caller's membership and (for a non-owner) their override.
    const workflowRow = {
        id: "w1",
        user_id: "author",
        org_id: ORG,
        visibility: "organization",
        title: "Disclosure",
        type: "assistant",
    };

    it("lets an owner of the workflow make it private", async () => {
        const fake = scriptedDb([
            { table: "workflows", data: workflowRow },
            { table: "workflows", data: workflowRow },
            { table: "org_members", data: { role: "owner" } },
            {
                table: "workflows",
                op: "update",
                data: { ...workflowRow, visibility: "private" },
            },
        ]);
        const result = await updateWorkflow(fake.db, {
            workflowId: "w1",
            userId: "principal",
            userEmail: "principal@firm.example",
            body: { visibility: "private" },
        });

        expect(result).toMatchObject({ ok: true });
        expect(fake.calls[3].payload).toEqual({ visibility: "private" });
        fake.done();
    });

    it("stops an editor changing who can open it, while still letting them edit", async () => {
        // On a public workflow a plain member is an Editor: the content is
        // theirs to change, the audience is not.
        const steps = [
            { table: "workflows", data: workflowRow },
            { table: "workflows", data: workflowRow },
            { table: "org_members", data: { role: "member" } },
            { table: "workflow_org_access_overrides", data: null },
        ];
        const refused = scriptedDb(steps);
        await expect(
            updateWorkflow(refused.db, {
                workflowId: "w1",
                userId: "colleague",
                userEmail: "colleague@firm.example",
                body: { visibility: "private" },
            }),
        ).resolves.toMatchObject({ ok: false, kind: "forbidden" });
        refused.done();

        const allowed = scriptedDb([
            ...steps,
            { table: "workflows", op: "update", data: workflowRow },
        ]);
        await expect(
            updateWorkflow(allowed.db, {
                workflowId: "w1",
                userId: "colleague",
                userEmail: "colleague@firm.example",
                body: { metadata: { title: "Renamed" } },
            }),
        ).resolves.toMatchObject({ ok: true });
        allowed.done();
    });

    it("hides a private workflow from a member it was not shared with", async () => {
        const fake = scriptedDb([
            { table: "workflows", data: { ...workflowRow, visibility: "private" } },
            { table: "workflows", data: { ...workflowRow, visibility: "private" } },
            { table: "org_members", data: { role: "admin" } },
            { table: "workflow_org_access_overrides", data: null },
            { rpc: "org_private_access_role", data: null },
        ]);
        await expect(
            updateWorkflow(fake.db, {
                workflowId: "w1",
                userId: "manager",
                userEmail: "manager@firm.example",
                body: { metadata: { title: "Renamed" } },
            }),
        ).resolves.toEqual({ ok: false, kind: "not_editable" });
        fake.done();
    });
});
