import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../__tests__/helpers/scriptedDb";
import { wordChatHasWorkspaceAttachments } from "../wordWorkspace";

const organizations = { table: "organizations", data: [{ id: "firm", kind: "team" }, { id: "own-org", kind: "personal" }] };
const message = { files: [{ document_id: "doc" }] };

describe("Word Personal boundary", () => {
  it.each([null, "own-org"])("allows Personal document placement %s", async org_id => {
    const fake = scriptedDb([
      { table: "documents", data: [{ id: "doc", org_id }] },
      ...(org_id ? [organizations] : []),
    ]);
    expect(await wordChatHasWorkspaceAttachments(fake.db, [message])).toBe(false);
    fake.done();
  });

  it("rejects organization documents in client history", async () => {
    const fake = scriptedDb([{ table: "documents", data: [{ id: "doc", org_id: "firm" }] }, organizations]);
    expect(await wordChatHasWorkspaceAttachments(fake.db, [message])).toBe(true);
    fake.done();
  });

  it("uses a project document's authoritative organization", async () => {
    const fake = scriptedDb([
      { table: "documents", data: [{ id: "doc", org_id: null, project_id: "project" }] },
      { table: "projects", data: [{ id: "project", org_id: "firm" }] }, organizations,
    ]);
    expect(await wordChatHasWorkspaceAttachments(fake.db, [message])).toBe(true);
    fake.done();
  });

  it("rejects organization workflow assets supplied as document attachments", async () => {
    const fake = scriptedDb([
      { table: "documents", data: [{ id: "doc", org_id: null, workflow_id: "wf" }] },
      { table: "workflows", data: [{ id: "wf", org_id: "firm" }] }, organizations,
    ]);
    expect(await wordChatHasWorkspaceAttachments(fake.db, [message])).toBe(true);
    fake.done();
  });

  it("rejects historical attachments omitted from the client's request and memory input", async () => {
    const fake = scriptedDb([
      { table: "word_chat_messages", data: [message] },
      { table: "documents", data: [{ id: "doc", org_id: "firm" }] }, organizations,
    ]);
    expect(await wordChatHasWorkspaceAttachments(fake.db, [], "chat")).toBe(true);
    fake.done();
  });

  it("rejects an organization workflow even without document attachments", async () => {
    const fake = scriptedDb([{ table: "workflows", data: [{ id: "wf", org_id: "firm" }] }, organizations]);
    expect(await wordChatHasWorkspaceAttachments(fake.db, [{ workflow: { id: "wf" } }])).toBe(true);
    fake.done();
  });

  it("rejects an organization playbook, and ignores an id that cannot name one", async () => {
    const playbookId = "5d0c1c7e-8f0e-4c55-9a43-3c1d2f9f6b10";
    const fake = scriptedDb([{ table: "playbooks", data: [{ id: playbookId, org_id: "firm" }] }, organizations]);
    expect(await wordChatHasWorkspaceAttachments(fake.db, [
      { playbook: { id: playbookId } },
      { playbook: { id: "not-a-uuid" } },
    ])).toBe(true);
    fake.done();
  });

  it("fails closed on a stored-history lookup failure", async () => {
    const fake = scriptedDb([{ table: "word_chat_messages", error: { message: "offline" } }]);
    await expect(wordChatHasWorkspaceAttachments(fake.db, [], "chat")).rejects.toThrow();
  });
});
