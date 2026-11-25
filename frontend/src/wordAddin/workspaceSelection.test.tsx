/**
 * The task pane's workspace: which one is remembered, what the history says
 * in it, and how the pane falls back to Personal from an organization the
 * caller has left.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listOrgs, listCloudWordChats, notifyInfo } = vi.hoisted(() => ({
    listOrgs: vi.fn(),
    listCloudWordChats: vi.fn(),
    notifyInfo: vi.fn(),
}));
vi.mock("../../../word-addin/src/taskpane/api/mikeApi", () => ({
    listOrgs,
    listCloudWordChats,
}));
vi.mock("../../../word-addin/src/taskpane/lib/notify", () => ({
    notifyInfo,
    reportFault: (_error: unknown, options: { fallback: string }) => ({
        message: options.fallback,
    }),
}));

import { workspaceStorageKey } from "@mike/client";
import {
    AddinWorkspaceProvider,
    useAddinWorkspace,
} from "../../../word-addin/src/taskpane/lib/addinWorkspace";
import { usePaginatedChats } from "../../../word-addin/src/taskpane/hooks/usePaginatedChats";
import {
    announceWorkspaceGone,
    historyEmptyLabel,
    isWorkspaceGoneError,
    paneWorkspaceStorage,
    workspaceGoneMessage,
    workspaceStorageNotice,
} from "../../../word-addin/src/taskpane/lib/workspaceState";

const USER = "user-1";
const ORG = "11111111-1111-4111-8111-111111111111";
const FIRM = { id: ORG, name: "Firm LLP" };

function wrapper({ children }: { children: ReactNode }) {
    return <AddinWorkspaceProvider userId={USER}>{children}</AddinWorkspaceProvider>;
}

beforeEach(() => {
    localStorage.clear();
    listOrgs.mockReset();
    listCloudWordChats.mockReset();
    notifyInfo.mockReset();
});
afterEach(() => {
    localStorage.clear();
});

describe("workspace wording", () => {
    it("says why an organization has no device-only chats", () => {
        expect(workspaceStorageNotice("local", ORG, [FIRM])).toBe(
            "Chats in Firm LLP are saved to your account. Turn on cloud chat history in Settings to chat here.",
        );
        expect(workspaceStorageNotice("local", ORG, null)).toContain("this organization");
        expect(workspaceStorageNotice("cloud", ORG, [FIRM])).toBeNull();
        expect(workspaceStorageNotice("local", "personal", [FIRM])).toBeNull();
    });

    it("names the workspace in an empty history", () => {
        expect(historyEmptyLabel("", "personal", [FIRM])).toBe(
            "No chats saved for this document",
        );
        expect(historyEmptyLabel("", ORG, [FIRM])).toBe(
            "No chats in Firm LLP for this document",
        );
        expect(historyEmptyLabel("memo", ORG, [FIRM])).toBe("No matches found");
    });

    it("recognises the server's refusal for a workspace the caller has left", () => {
        expect(isWorkspaceGoneError({ status: 404, code: "workspace_not_found" })).toBe(true);
        expect(isWorkspaceGoneError({ status: 404, code: null })).toBe(false);
    });

    it("remembers the workspace under the web app's key", async () => {
        await paneWorkspaceStorage.setItem(workspaceStorageKey(USER), ORG);
        expect(localStorage.getItem("mike.activeWorkspace.user-1")).toBe(ORG);
        await expect(paneWorkspaceStorage.getItem(workspaceStorageKey(USER))).resolves.toBe(ORG);
    });
});

describe("AddinWorkspaceProvider", () => {
    it("is not ready until the remembered workspace is read, then restores it", async () => {
        localStorage.setItem(workspaceStorageKey(USER), ORG);
        listOrgs.mockResolvedValue([FIRM]);
        const { result } = renderHook(() => useAddinWorkspace(), { wrapper });

        expect(result.current.ready).toBe(false);
        expect(result.current.workspaceId).toBe("personal");
        await waitFor(() => expect(result.current.ready).toBe(true));
        await waitFor(() => expect(result.current.activeOrganization).toEqual(FIRM));
        expect(result.current.workspaceId).toBe(ORG);
    });

    it("switches to an organization and remembers it", async () => {
        listOrgs.mockResolvedValue([FIRM]);
        const { result } = renderHook(() => useAddinWorkspace(), { wrapper });
        await waitFor(() => expect(result.current.organizations).toEqual([FIRM]));

        act(() => result.current.setWorkspace(ORG));

        expect(result.current.workspaceId).toBe(ORG);
        await waitFor(() =>
            expect(localStorage.getItem(workspaceStorageKey(USER))).toBe(ORG),
        );
    });

    it("falls back to Personal, and says so, after a workspace_not_found", async () => {
        localStorage.setItem(workspaceStorageKey(USER), ORG);
        listOrgs.mockResolvedValueOnce([FIRM]);
        const { result } = renderHook(() => useAddinWorkspace(), { wrapper });
        await waitFor(() => expect(result.current.activeOrganization).toEqual(FIRM));

        // The caller was removed from the organization; a list found out.
        listOrgs.mockResolvedValueOnce([]);
        act(() => announceWorkspaceGone());

        await waitFor(() => expect(result.current.workspaceId).toBe("personal"));
        expect(notifyInfo).toHaveBeenCalledExactlyOnceWith(workspaceGoneMessage("Firm LLP"));
    });

    it("stays put, without a notice, when the organization is still listed", async () => {
        localStorage.setItem(workspaceStorageKey(USER), ORG);
        listOrgs.mockResolvedValue([FIRM]);
        const { result } = renderHook(() => useAddinWorkspace(), { wrapper });
        await waitFor(() => expect(result.current.activeOrganization).toEqual(FIRM));

        act(() => announceWorkspaceGone());

        await waitFor(() => expect(listOrgs).toHaveBeenCalledTimes(2));
        expect(result.current.workspaceId).toBe(ORG);
        expect(notifyInfo).not.toHaveBeenCalled();
    });

    it("reads as Personal outside a provider", () => {
        const { result } = renderHook(() => useAddinWorkspace());
        expect(result.current).toMatchObject({ workspaceId: "personal", ready: true });
    });
});

describe("Word chat history in a workspace", () => {
    const chat = {
        id: "chat-1",
        project_id: null,
        user_id: USER,
        org_id: ORG,
        title: "Org chat",
        created_at: "2026-11-21T10:00:00Z",
    };

    it("lists only the organization's cloud chats", async () => {
        listCloudWordChats.mockResolvedValue([chat]);
        const { result } = renderHook(() =>
            usePaginatedChats(10, true, "document-1", USER, "cloud", ORG),
        );
        await waitFor(() => expect(result.current.chats).toEqual([chat]));
        expect(listCloudWordChats).toHaveBeenCalledWith(
            "document-1",
            11,
            0,
            expect.any(AbortSignal),
            ORG,
        );
    });

    it("lists nothing, and asks for nothing, for an organization with chats on the device", async () => {
        const { result } = renderHook(() =>
            usePaginatedChats(10, true, "document-1", USER, "local", ORG),
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.chats).toEqual([]);
        expect(result.current.error).toBeNull();
        expect(listCloudWordChats).not.toHaveBeenCalled();
    });

    it("says the caller has left the workspace on a 404 workspace_not_found", async () => {
        listCloudWordChats.mockRejectedValue(
            Object.assign(new Error("Workspace not found"), {
                status: 404,
                code: "workspace_not_found",
            }),
        );
        const { result } = renderHook(() =>
            usePaginatedChats(10, true, "document-1", USER, "cloud", ORG),
        );
        await waitFor(() =>
            expect(result.current.error).toBe("You're no longer a member of this workspace."),
        );
    });
});
