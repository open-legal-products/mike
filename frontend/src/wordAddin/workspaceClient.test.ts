/**
 * The task pane's requests in a workspace: an organization's lists are asked
 * for with `?workspace=<org id>`, a chat started there carries `org_id`, and
 * a list refused with 404 `workspace_not_found` tells the pane that the
 * caller has left the organization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../word-addin/src/taskpane/lib/errorReporting", () => ({
    reportNetworkFailure: vi.fn(),
    reportApiFailure: vi.fn(),
    reportError: vi.fn(),
}));

import {
    configureMikeApiClient,
    getLibrary,
    getLibraryFolderChildren,
    listOrgs,
    listPlaybooks,
    listProjects,
    listQuickActions,
    listWorkflows,
    streamWordChat,
    uploadStandaloneDocuments,
} from "../../../word-addin/src/taskpane/api/client";
import { onWorkspaceGone } from "../../../word-addin/src/taskpane/lib/workspaceState";

const ORG = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
const chatPayload = {
    messages: [{ role: "user", content: "Summarise this." }],
    document_id: "document-1",
    document_name: "Draft",
    storage: "cloud" as const,
    edit_apply_mode: "approval" as const,
};
const sentBody = (call = 0) =>
    JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;

beforeEach(() => {
    fetchMock.mockReset();
    configureMikeApiClient({
        baseUrl: "https://api.example.test",
        getAuthHeaders: async () => ({}),
        fetchImpl: fetchMock,
    });
});

describe("Word pickers in an organization's workspace", () => {
    it("narrows every list to the organization", async () => {
        fetchMock.mockImplementation(async () => json([]));
        await listProjects({ workspace: ORG });
        await getLibrary("files", { workspace: ORG });
        await getLibraryFolderChildren("templates", "folder-1", { workspace: ORG });
        await listWorkflows("assistant", ORG);
        await listQuickActions(ORG);
        await listPlaybooks(ORG);

        const urls = fetchMock.mock.calls.map(([input]) => new URL(String(input)));
        expect(urls.map((url) => url.pathname)).toEqual([
            "/projects",
            "/library/files",
            "/library/templates",
            "/workflows",
            "/quick-actions",
            "/playbooks",
        ]);
        for (const url of urls) expect(url.searchParams.get("workspace")).toBe(ORG);
        expect(urls[2]?.searchParams.get("parent_folder_id")).toBe("folder-1");
        expect(urls[4]?.searchParams.get("surface")).toBe("word");
    });

    it("keeps Personal when no workspace is named", async () => {
        fetchMock.mockImplementation(async () => json([]));
        await listPlaybooks();
        expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("workspace")).toBe(
            "personal",
        );
    });

    it("files an upload in the organization", async () => {
        fetchMock.mockImplementationOnce(async () => json({ detail: "stop here" }, 400));
        await uploadStandaloneDocuments(
            [new File(["x"], "brief.docx")],
            { workspace: ORG },
        ).catch(() => undefined);
        expect(sentBody()).toMatchObject({
            destination: { scope: "standalone", org_id: ORG },
        });
    });

    it("files a Personal upload with no org_id", async () => {
        fetchMock.mockImplementationOnce(async () => json({ detail: "stop here" }, 400));
        await uploadStandaloneDocuments([new File(["x"], "brief.docx")]).catch(() => undefined);
        expect(sentBody().destination).toEqual({ scope: "standalone" });
    });

    it("lists the caller's organizations for the workspace menu", async () => {
        fetchMock.mockResolvedValueOnce(json([{ id: ORG, name: "Firm" }]));
        await expect(listOrgs()).resolves.toEqual([{ id: ORG, name: "Firm" }]);
        expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe("/orgs");
    });
});

describe("starting a Word chat in a workspace", () => {
    it("sends org_id for an organization", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
        await streamWordChat({ ...chatPayload, workspace: ORG });
        expect(sentBody()).toMatchObject({ org_id: ORG, storage: "cloud" });
        expect(sentBody()).not.toHaveProperty("workspace");
    });

    it("sends no org_id in Personal", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
        await streamWordChat({ ...chatPayload, workspace: "personal" });
        expect(sentBody()).not.toHaveProperty("org_id");
    });

    it("still sends org_id for a device-only chat, so the server can refuse it", async () => {
        fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
        await streamWordChat({
            ...chatPayload,
            storage: "local",
            chat_id: "local-chat",
            workspace: ORG,
        });
        expect(sentBody()).toMatchObject({ org_id: ORG, storage: "local" });
    });
});

describe("a workspace the caller has left", () => {
    let gone: ReturnType<typeof vi.fn<() => void>>;
    let stop: () => void;
    beforeEach(() => {
        gone = vi.fn<() => void>();
        stop = onWorkspaceGone(gone);
    });
    afterEach(() => stop());

    it("announces a 404 workspace_not_found and keeps the error's code", async () => {
        fetchMock.mockResolvedValueOnce(
            json({ detail: "Workspace not found", code: "workspace_not_found" }, 404),
        );
        await expect(listWorkflows("assistant", ORG)).rejects.toMatchObject({
            status: 404,
            code: "workspace_not_found",
        });
        expect(gone).toHaveBeenCalledTimes(1);
    });

    it("does not announce any other 404", async () => {
        fetchMock.mockResolvedValueOnce(json({ detail: "Not found" }, 404));
        await listWorkflows("assistant", ORG).catch(() => undefined);
        expect(gone).not.toHaveBeenCalled();
    });
});
