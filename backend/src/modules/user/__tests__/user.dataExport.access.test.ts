import { describe, expect, it } from "vitest";
import {
    buildUserAccountExport,
    buildUserChatsExport,
    buildUserTabularReviewsExport,
} from "../user.dataExport";
import { makeExportDb, type Row } from "./user.dataExport.fixture";

const userId = "departed-user";
const email = "departed@example.test";
const resource = (id: string, fields: Row = {}): Row => ({
    id,
    user_id: userId,
    project_id: null,
    org_id: null,
    archived_at: null,
    ...fields,
});
const ids = (rows: Row[]) => rows.map((row) => row.id);

function fixtures(): Record<string, Row[]> {
    const scopes = ["personal", "current", "departed", "denied", "archived"];
    const scoped = (kind: string) => scopes.map((scope) => resource(`${kind}-${scope}`, {
        org_id: scope === "personal" ? null : scope === "departed" ? "old-org" : "current-org",
        archived_at: scope === "archived" ? "2026-10-13T00:00:00Z" : null,
        ...(scope === "denied" ? { project_id: "project-denied" } : {}),
    }));
    const projects: Row[] = scoped("project").map((row) => ({
        ...row,
        project_id: undefined,
        user_id: row.id === "project-denied" ? "colleague" : userId,
        visibility: "organization",
    }));
    const reviews = scoped("review");
    const chats = scoped("chat");
    const documents = [
        ...scoped("document"),
        resource("document-departed-project", { project_id: "project-departed", org_id: "old-org" }),
        resource("document-departed-workflow", { workflow_id: "workflow-departed", org_id: "old-org" }),
        resource("document-current-project", { project_id: "project-current", org_id: "current-org", user_id: "colleague" }),
    ];
    return {
        organizations: [{ id: "old-org", kind: "team" }, { id: "current-org", kind: "team" }],
        org_members: [{ org_id: "current-org", user_id: userId, role: "member" }],
        project_org_access_overrides: [{ project_id: "project-denied", org_id: "current-org", user_id: userId, role: "deny" }],
        projects,
        project_subfolders: projects.map((row) => ({ id: `folder-${row.id}`, project_id: row.id })),
        workflows: [
            resource("workflow-personal"),
            resource("workflow-current", { org_id: "current-org" }),
            resource("workflow-departed", { org_id: "old-org" }),
            resource("workflow-archived", { org_id: "current-org", archived_at: "2026-10-13T00:00:00Z" }),
        ],
        documents,
        document_versions: documents.map((row) => ({ id: `version-${row.id}`, document_id: row.id })),
        document_edits: documents.map((row) => ({ id: `edit-${row.id}`, document_id: row.id })),
        chats,
        chat_messages: chats.map((row) => ({ id: `message-${row.id}`, chat_id: row.id })),
        tabular_reviews: reviews,
        tabular_cells: reviews.map((row) => ({ id: `cell-${row.id}`, review_id: row.id })),
        tabular_review_chats: [
            ...reviews.map((row) => resource(`thread-${row.id}`, { review_id: row.id })),
            resource("orphan-thread", { review_id: "missing-review" }),
        ],
        tabular_review_chat_messages: reviews.map((row) => ({ id: `message-${row.id}`, chat_id: `thread-${row.id}` })),
    };
}

describe("exports enforce current read access", () => {
    it("excludes departed, denied and archived content and its descendants from account exports", async () => {
        const { db } = makeExportDb(fixtures());
        const personal = await buildUserAccountExport(db, userId, email, null);

        expect(personal.workspace).toEqual({ personal: true });
        expect(ids(personal.projects)).toEqual(["project-personal"]);
        expect(ids(personal.project_subfolders)).toEqual(["folder-project-personal"]);
        expect(ids(personal.workflows)).toEqual(["workflow-personal"]);
        expect(ids(personal.documents)).toEqual(["document-personal"]);
        expect(ids(personal.document_versions)).toEqual(["version-document-personal"]);
        expect(ids(personal.document_edits)).toEqual(["edit-document-personal"]);
        expect(ids(personal.chats.chats)).toEqual(["chat-personal"]);
        expect(ids(personal.chats.messages)).toEqual(["message-chat-personal"]);
        expect(ids(personal.tabular_reviews)).toEqual(["review-personal"]);
        expect(ids(personal.tabular_cells)).toEqual(["cell-review-personal"]);
        expect(ids(personal.tabular_review_chats.chats)).toEqual(["thread-review-personal"]);
        expect(ids(personal.tabular_review_chats.messages)).toEqual(["message-review-personal"]);

        const firm = await buildUserAccountExport(db, userId, email, "current-org");

        expect(firm.workspace).toEqual({ organization_id: "current-org" });
        expect(ids(firm.projects)).toEqual(["project-current"]);
        expect(ids(firm.project_subfolders)).toEqual(["folder-project-current"]);
        expect(ids(firm.workflows)).toEqual(["workflow-current"]);
        expect(ids(firm.documents)).toEqual(["document-current", "document-current-project"]);
        expect(ids(firm.document_versions)).toEqual(["version-document-current", "version-document-current-project"]);
        expect(ids(firm.document_edits)).toEqual(["edit-document-current", "edit-document-current-project"]);
        expect(ids(firm.chats.chats)).toEqual(["chat-current"]);
        expect(ids(firm.chats.messages)).toEqual(["message-chat-current"]);
        expect(ids(firm.tabular_reviews)).toEqual(["review-current"]);
        expect(ids(firm.tabular_cells)).toEqual(["cell-review-current"]);
        expect(ids(firm.tabular_review_chats.chats)).toEqual(["thread-review-current"]);
        expect(ids(firm.tabular_review_chats.messages)).toEqual(["message-review-current"]);
    });

    it("leaves the account itself to the Personal export", async () => {
        const { db } = makeExportDb({
            ...fixtures(),
            user_profiles: [{ id: "profile", user_id: userId }],
            quick_actions: [{ id: "quick-action", user_id: userId }],
        });
        const personal = await buildUserAccountExport(db, userId, email, null);
        const firm = await buildUserAccountExport(db, userId, email, "current-org");

        expect(ids(personal.profile!)).toEqual(["profile"]);
        expect(ids(personal.quick_actions!)).toEqual(["quick-action"]);
        expect(personal.org_members).toEqual([{ org_id: "current-org", user_id: userId, role: "member" }]);
        for (const key of ["profile", "api_keys", "router_models", "organizations", "org_members", "org_invitations", "quick_actions", "hidden_workflows"])
            expect(firm).not.toHaveProperty(key);
    });

    it("exports the memory of the workspace it covers, not whichever file comes first", async () => {
        const { db } = makeExportDb({
            memory_files: [
                { id: "firm-memory", scope: "user", user_id: userId, org_id: "current-org", enabled: true, epoch: 1, revision: 1, content: "# Firm", status: "idle" },
                { id: "personal-memory", scope: "user", user_id: userId, org_id: null, enabled: true, epoch: 1, revision: 1, content: "# Personal", status: "idle" },
            ],
        });

        expect((await buildUserAccountExport(db, userId, email, null)).memory.markdown).toBe("# Personal");
        expect((await buildUserAccountExport(db, userId, email, "current-org")).memory.markdown).toBe("# Firm");
    });

    it("applies the same rules to chat-only and review-only exports", async () => {
        const { db } = makeExportDb(fixtures());
        const chats = await buildUserChatsExport(db, userId, email, null);
        const reviews = await buildUserTabularReviewsExport(db, userId, email, null);

        expect(ids(chats.assistant_chats.chats)).toEqual(["chat-personal"]);
        expect(ids(chats.assistant_chats.messages)).toEqual(["message-chat-personal"]);
        expect(ids(chats.tabular_review_chats.chats)).toEqual(["thread-review-personal"]);
        expect(ids(chats.tabular_review_chats.messages)).toEqual(["message-review-personal"]);
        expect(ids(reviews.tabular_reviews)).toEqual(["review-personal"]);
        expect(ids(reviews.tabular_cells)).toEqual(["cell-review-personal"]);
        expect(ids(reviews.tabular_review_chats.chats)).toEqual(["thread-review-personal"]);
        expect(ids(reviews.tabular_review_chats.messages)).toEqual(["message-review-personal"]);

        const firmChats = await buildUserChatsExport(db, userId, email, "current-org");
        const firmReviews = await buildUserTabularReviewsExport(db, userId, email, "current-org");

        expect(ids(firmChats.assistant_chats.chats)).toEqual(["chat-current"]);
        expect(ids(firmChats.tabular_review_chats.chats)).toEqual(["thread-review-current"]);
        expect(ids(firmReviews.tabular_reviews)).toEqual(["review-current"]);
        expect(ids(firmReviews.tabular_review_chats.chats)).toEqual(["thread-review-current"]);
    });

    it("keeps accessible shared review transcripts and excludes them after membership or sharing is revoked", async () => {
        const tables: Record<string, Row[]> = {
            organizations: [{ id: "org", kind: "team" }],
            org_members: [{ org_id: "org", user_id: userId, role: "member" }],
            tabular_reviews: [resource("shared-review", { user_id: "colleague", org_id: "org" })],
            tabular_review_access_grants: [{ tabular_review_id: "shared-review", email, role: "viewer" }],
            tabular_review_chats: [resource("thread", { review_id: "shared-review" })],
            tabular_review_chat_messages: [{ id: "message", chat_id: "thread", content: "Retained team discussion" }],
        };
        const { db } = makeExportDb(tables);
        const before = await buildUserChatsExport(db, userId, email, "org");
        expect(ids(before.tabular_review_chats.messages)).toEqual(["message"]);
        // A colleague's review in the organization is not Personal's.
        expect((await buildUserChatsExport(db, userId, email, null)).tabular_review_chats).toEqual({ chats: [], messages: [] });

        tables.org_members = [];
        tables.tabular_review_chat_messages.push({ id: "after-removal", chat_id: "thread", content: "Written after removal" });
        const after = await buildUserChatsExport(db, userId, email, "org");
        const account = await buildUserAccountExport(db, userId, email, "org");
        expect(after.tabular_review_chats).toEqual({ chats: [], messages: [] });
        expect(account.tabular_review_chats).toEqual({ chats: [], messages: [] });
        expect(account.shared_access.tabular_reviews).toEqual([]);

        tables.org_members = [{ org_id: "org", user_id: userId, role: "member" }];
        tables.tabular_review_access_grants = [];
        expect((await buildUserChatsExport(db, userId, email, "org")).tabular_review_chats).toEqual({ chats: [], messages: [] });
    });

    it("does not treat stale direct project grants as organization membership", async () => {
        const { db } = makeExportDb({
            projects: [resource("team-project", { user_id: "colleague", org_id: "departed-org", visibility: "organization" })],
            project_access_grants: [{ project_id: "team-project", email, role: "owner" }],
        });
        expect((await buildUserAccountExport(db, userId, email, "departed-org")).shared_access.projects).toEqual([]);
    });

    it("keeps personal data without an email, including Word transcripts", async () => {
        const { db } = makeExportDb({
            chats: [resource("personal-chat")],
            chat_messages: [{ id: "personal-message", chat_id: "personal-chat" }],
            word_documents: [resource("word-doc")],
            word_chats: [resource("word-chat", { word_document_id: "word-doc" })],
            word_chat_messages: [{ id: "word-message", chat_id: "word-chat" }],
        });
        const result = await buildUserChatsExport(db, userId, undefined, null);
        expect(ids(result.assistant_chats.messages)).toEqual(["personal-message"]);
        expect(ids(result.word_addin_chats.messages)).toEqual(["word-message"]);
        // The add-in works in Personal only.
        const firm = await buildUserChatsExport(db, userId, undefined, "current-org");
        expect(firm.word_addin_chats).toEqual({ documents: [], chats: [], messages: [] });
    });

    it("exports the user's own readable playbooks, their runs and imports, and nobody else's", async () => {
        const playbook = (id: string, fields: Row = {}): Row => ({
            id,
            user_id: userId,
            org_id: null,
            visibility: "private",
            content_json: { name: id },
            ...fields,
        });
        const { db } = makeExportDb({
            org_members: [{ org_id: "current-org", user_id: userId, role: "member" }],
            playbooks: [
                playbook("playbook-personal"),
                playbook("playbook-current", { org_id: "current-org", visibility: "organization" }),
                // The user left this organization: its policy stays there.
                playbook("playbook-departed", { org_id: "old-org", visibility: "organization" }),
                playbook("playbook-colleague-public", { user_id: "colleague", org_id: "current-org", visibility: "organization" }),
                playbook("playbook-colleague-private", { user_id: "colleague", org_id: "current-org" }),
                playbook("playbook-stranger", { user_id: "stranger" }),
            ],
            playbook_sources: [
                { id: "source-personal", playbook_id: "playbook-personal", filename: "policy.pdf", extracted_text: "secret" },
                { id: "source-colleague", playbook_id: "playbook-colleague-public", filename: "theirs.pdf" },
            ],
            playbook_runs: [
                { id: "run-personal", playbook_id: "playbook-personal", user_id: userId, findings_json: [] },
                { id: "run-departed", playbook_id: "playbook-departed", user_id: userId },
                { id: "run-colleague-public", playbook_id: "playbook-colleague-public", user_id: userId },
                { id: "run-colleague-private", playbook_id: "playbook-colleague-private", user_id: userId },
                { id: "run-by-colleague", playbook_id: "playbook-personal", user_id: "colleague" },
            ],
            playbook_imports: [
                { id: "import-personal", user_id: userId, org_id: null },
                { id: "import-departed", user_id: userId, org_id: "old-org" },
                { id: "import-colleague", user_id: "colleague", org_id: null },
            ],
        });

        const result = await buildUserAccountExport(db, userId, email, null);

        expect(ids(result.playbooks)).toEqual(["playbook-personal"]);
        expect(result.playbooks[0].content_json).toEqual({ name: "playbook-personal" });
        expect(ids(result.playbook_sources)).toEqual(["source-personal"]);
        expect(ids(result.playbook_runs)).toEqual(["run-personal"]);
        expect(ids(result.playbook_imports)).toEqual(["import-personal"]);

        const firm = await buildUserAccountExport(db, userId, email, "current-org");

        expect(ids(firm.playbooks)).toEqual(["playbook-current"]);
        expect(ids(firm.playbook_sources)).toEqual([]);
        expect(ids(firm.playbook_runs)).toEqual(["run-colleague-public"]);
        expect(ids(firm.playbook_imports)).toEqual([]);
    });

    it("fails closed when organization membership or scope cannot be read", async () => {
        const tables = fixtures();
        const membershipFailure = makeExportDb(tables, { org_members: { message: "unavailable" } });
        const result = await buildUserChatsExport(membershipFailure.db, userId, email, "current-org");
        expect(ids(result.assistant_chats.chats)).toEqual([]);
        expect(ids(result.tabular_review_chats.chats)).toEqual([]);

        const scopeFailure = makeExportDb(tables, { organizations: { message: "unavailable" } });
        await expect(buildUserChatsExport(scopeFailure.db, userId, email, "current-org")).rejects.toThrow("Failed to read the organization's kind");
    });
});
