/**
 * The sidebar history follows the active workspace. A switch re-reads the
 * first page, and the previous workspace's chats must neither linger on
 * screen nor land on top of the new list when their slower answer arrives.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

const listChats = vi.fn();
const createChat = vi.fn();
const renameChat = vi.fn();
const deleteChat = vi.fn();
const leaveChat = vi.fn();
const notifyError = vi.hoisted(() => vi.fn());
const workspace = vi.hoisted(() => ({
    current: "personal" as string | undefined,
}));
const STABLE_USER = vi.hoisted(() => ({ id: "u1", email: "u1@example.com" }));
const auth = vi.hoisted(() => ({ user: STABLE_USER as typeof STABLE_USER | null }));

vi.mock("@/app/lib/mikeApi", () => ({
    createChat: (...args: unknown[]) => createChat(...args),
    listChats: (...args: unknown[]) => listChats(...args),
    renameChat: (...args: unknown[]) => renameChat(...args),
    deleteChat: (...args: unknown[]) => deleteChat(...args),
    leaveChat: (...args: unknown[]) => leaveChat(...args),
}));
vi.mock("@/app/lib/userFacingError", () => ({ notifyError }));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: auth.user }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspaceParam: () => workspace.current,
    useWorkspaceOrgId: () =>
        workspace.current && workspace.current !== "personal"
            ? workspace.current
            : undefined,
}));

import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";

const chat = (id: string, title: string) => ({
    id,
    title,
    user_id: "u1",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    is_owner: true,
});

let saveChat: ReturnType<typeof useChatHistoryContext>["saveChat"];
let latest: ReturnType<typeof useChatHistoryContext>;
let loadMoreChats: ReturnType<typeof useChatHistoryContext>["loadMoreChats"];
function Probe() {
    const context = useChatHistoryContext();
    useEffect(() => {
        saveChat = context.saveChat;
        latest = context;
        loadMoreChats = context.loadMoreChats;
    });
    const { chats } = context;
    return (
        <p>
            {chats === null
                ? "loading"
                : chats.map((item) => item.title).join(",") || "empty"}
        </p>
    );
}

const tree = () => (
    <ChatHistoryProvider>
        <Probe />
    </ChatHistoryProvider>
);

beforeEach(() => {
    vi.clearAllMocks();
    workspace.current = "personal";
    auth.user = STABLE_USER;
});

// A chat started on its own belongs to the workspace it is started in.
describe("starting a chat", () => {
    beforeEach(() => {
        listChats.mockResolvedValue([]);
        createChat.mockResolvedValue({ id: "new-chat" });
    });

    it("files it under the organization whose workspace is active", async () => {
        workspace.current = "org-1";
        render(tree());
        await screen.findByText("empty");

        await act(async () => {
            await saveChat();
        });
        expect(createChat).toHaveBeenCalledWith({ org_id: "org-1" });
    });

    it("names no organization in Personal", async () => {
        render(tree());
        await screen.findByText("empty");

        await act(async () => {
            await saveChat();
        });
        expect(createChat).toHaveBeenCalledWith(undefined);
    });

    it("lets the project decide for a chat started inside one", async () => {
        workspace.current = "org-1";
        render(tree());
        await screen.findByText("empty");

        await act(async () => {
            await saveChat("proj-1");
        });
        expect(createChat).toHaveBeenCalledWith({ project_id: "proj-1" });
    });
});

describe("ChatHistoryProvider and the active workspace", () => {
    it.each([
        ["loadChats", "workspace round trip"],
        ["loadMoreChats", "workspace round trip"],
        ["saveChat", "workspace round trip"],
        ["loadChats", "sign-out"],
        ["loadMoreChats", "sign-out"],
        ["saveChat", "sign-out"],
    ] as const)("ignores a stale %s failure after a %s", async (operation, transition) => {
        const page = Array.from({ length: 21 }, (_, index) =>
            chat(`c${index}`, `Personal note ${index}`),
        );
        listChats.mockResolvedValue(page);
        const { rerender } = render(tree());
        await waitFor(() => expect(latest.hasMoreChats).toBe(true));

        let reject!: (reason: Error) => void;
        const api = operation === "saveChat" ? createChat : listChats;
        api.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
        let pending!: Promise<unknown>;
        act(() => { pending = latest[operation](); });

        if (transition === "sign-out") {
            auth.user = null;
            rerender(tree());
            await screen.findByText("empty");
        } else {
            workspace.current = "org-1";
            listChats.mockResolvedValueOnce([chat("org-chat", "Firm matter")]);
            rerender(tree());
            await screen.findByText("Firm matter");
            workspace.current = "personal";
            rerender(tree());
            await waitFor(() => expect(latest.chats).toHaveLength(20));
        }

        await act(async () => {
            reject(new Error("Old request failed"));
            await pending;
        });
        expect(notifyError).not.toHaveBeenCalled();
        expect(latest.chats).toHaveLength(transition === "sign-out" ? 0 : 20);
        expect(latest.loadingMoreChats).toBe(false);
    });

    it("ignores a reload callback retained by a detached turn in another workspace", async () => {
        listChats.mockImplementation(async ({ workspace: scope }) => [chat(scope, scope)]);
        const { rerender } = render(tree());
        await screen.findByText("personal");
        const oldReload = latest.loadChats;
        workspace.current = "org-1";
        rerender(tree());
        await screen.findByText("org-1");
        const callCount = listChats.mock.calls.length;
        await act(() => oldReload());
        expect(listChats).toHaveBeenCalledTimes(callCount);
        expect(latest.chats?.map(row => row.id)).toEqual(["org-1"]);
    });

    it("does not insert a pending creation into the newly selected workspace", async () => {
        listChats.mockImplementation(async ({ workspace: scope }) => [chat(scope, scope)]);
        let resolve!: (value: { id: string }) => void;
        createChat.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const { rerender } = render(tree());
        await screen.findByText("personal");
        const pending = saveChat();
        workspace.current = "org-1";
        rerender(tree());
        await screen.findByText("org-1");
        await act(async () => { resolve({ id: "created-in-personal" }); await pending; });
        expect(latest.chats?.map(row => row.id)).toEqual(["org-1"]);
    });

    it("discards a pending creation after switching away and back to the same workspace", async () => {
        listChats.mockImplementation(async ({ workspace: scope }) => [chat(scope, scope)]);
        let finish!: (value: { id: string }) => void;
        createChat.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        const { rerender } = render(tree());
        await screen.findByText("personal");
        const pending = saveChat();
        workspace.current = "org-1";
        rerender(tree());
        await screen.findByText("org-1");
        workspace.current = "personal";
        rerender(tree());
        await screen.findByText("personal");

        await act(async () => {
            finish({ id: "stale-creation" });
            expect(await pending).toBeNull();
        });
        expect(latest.chats?.map(row => row.id)).toEqual(["personal"]);
    });

    it.each(["renameChat", "deleteChat"] as const)("does not reload the old workspace when a pending %s fails", async (operation) => {
        listChats.mockImplementation(async ({ workspace: scope }) => [chat(scope, scope)]);
        let reject!: (reason: Error) => void;
        (operation === "renameChat" ? renameChat : deleteChat)
            .mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
        const { rerender } = render(tree());
        await screen.findByText("personal");
        let pending!: Promise<unknown>;
        act(() => { pending = latest[operation]("personal", "Renamed").catch(error => error); });
        workspace.current = "org-1";
        rerender(tree());
        await screen.findByText("org-1");
        const callCount = listChats.mock.calls.length;
        await act(async () => { reject(new Error("Denied")); await pending; });
        expect(listChats).toHaveBeenCalledTimes(callCount);
        expect(latest.chats?.map(row => row.id)).toEqual(["org-1"]);
    });

    it("drops old pagination after switching away and back and permits the new workspace to paginate", async () => {
        const page = (scope: string) => Array.from({ length: 21 }, (_, i) => chat(`${scope}-${i}`, `${scope}-${i}`));
        let resolveOld!: (rows: unknown[]) => void;
        listChats.mockImplementation(({ workspace: scope, beforeId }) => {
            if (!beforeId) return Promise.resolve(page(scope));
            if (scope === "personal") return new Promise(done => { resolveOld = done; });
            return Promise.resolve([chat("org-more", "Organization next page")]);
        });
        const { rerender } = render(tree());
        await waitFor(() => expect(latest.hasMoreChats).toBe(true));
        let pending!: Promise<void>;
        act(() => { pending = latest.loadMoreChats(); });
        workspace.current = "org-1";
        rerender(tree());
        await waitFor(() => expect(latest.chats?.[0].id).toBe("org-1-0"));
        expect(latest.loadingMoreChats).toBe(false);
        await act(() => latest.loadMoreChats());
        expect(latest.chats?.some(row => row.id === "org-more")).toBe(true);
        workspace.current = "personal";
        rerender(tree());
        await waitFor(() => expect(latest.chats?.[0].id).toBe("personal-0"));
        await act(async () => { resolveOld([chat("stale-personal", "Old page")]); await pending; });
        expect(latest.chats).toHaveLength(20);
        expect(latest.chats?.some(row => row.id === "stale-personal")).toBe(false);
    });

    it("drops a pending first page after sign-out", async () => {
        let resolve!: (rows: unknown[]) => void;
        listChats.mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const { rerender } = render(tree());
        await screen.findByText("loading");
        auth.user = null;
        rerender(tree());
        await screen.findByText("empty");
        await act(async () => resolve([chat("old-account", "Old account")]));
        expect(latest.chats).toEqual([]);
    });

    it("discards a pending history page when the user signs out", async () => {
        let resolvePage!: (rows: ReturnType<typeof chat>[]) => void;
        listChats
            .mockResolvedValueOnce(Array.from({ length: 21 }, (_, index) =>
                chat(`c${index}`, `Personal note ${index}`),
            ))
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolvePage = resolve;
            }));
        const { rerender } = render(tree());
        await screen.findByText(/Personal note 0/);

        let pending!: Promise<void>;
        act(() => { pending = loadMoreChats(); });
        expect(listChats).toHaveBeenLastCalledWith(expect.objectContaining({
            workspace: "personal",
            beforeId: "c19",
        }));

        auth.user = null;
        rerender(tree());
        await screen.findByText("empty");

        await act(async () => {
            resolvePage([chat("private", "Private history page")]);
            await pending;
        });
        expect(screen.getByText("empty")).toBeInTheDocument();
        expect(screen.queryByText("Private history page")).not.toBeInTheDocument();
    });

    it("asks for the active workspace's chats", async () => {
        listChats.mockResolvedValue([chat("c1", "Personal note")]);
        render(tree());

        await screen.findByText("Personal note");
        expect(listChats).toHaveBeenCalledWith(
            expect.objectContaining({ workspace: "personal" }),
        );
    });

    it("clears the list and reloads when the workspace changes", async () => {
        let resolveOrg!: (rows: unknown[]) => void;
        listChats.mockImplementation((options: { workspace?: string }) =>
            options.workspace === "org-1"
                ? new Promise((resolve) => {
                      resolveOrg = resolve;
                  })
                : Promise.resolve([chat("c1", "Personal note")]),
        );
        const { rerender } = render(tree());
        await screen.findByText("Personal note");

        workspace.current = "org-1";
        rerender(tree());

        // The personal chats leave the screen while the firm's are loading:
        // a list that still shows them would be naming the wrong workspace.
        await screen.findByText("loading");
        expect(screen.queryByText("Personal note")).not.toBeInTheDocument();

        await act(async () => resolveOrg([chat("c2", "Firm matter")]));
        await screen.findByText("Firm matter");
        expect(listChats).toHaveBeenLastCalledWith(
            expect.objectContaining({ workspace: "org-1" }),
        );
    });

    it("drops a previous workspace's answer that arrives after the switch", async () => {
        let resolvePersonal!: (rows: unknown[]) => void;
        listChats.mockImplementation((options: { workspace?: string }) =>
            options.workspace === "org-1"
                ? Promise.resolve([chat("c2", "Firm matter")])
                : new Promise((resolve) => {
                      resolvePersonal = resolve;
                  }),
        );
        const { rerender } = render(tree());
        await waitFor(() => expect(listChats).toHaveBeenCalledTimes(1));

        workspace.current = "org-1";
        rerender(tree());
        await screen.findByText("Firm matter");

        await act(async () => resolvePersonal([chat("c1", "Personal note")]));
        expect(screen.getByText("Firm matter")).toBeInTheDocument();
        expect(screen.queryByText("Personal note")).not.toBeInTheDocument();
    });
});


describe("leaving shared chats", () => {
    it("replaces an in-flight initial history read after leaving a directly opened chat", async () => {
        let finishOld!: (rows: ReturnType<typeof chat>[]) => void;
        listChats.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
            .mockResolvedValueOnce([chat("other", "Other chat")]);
        leaveChat.mockResolvedValue(undefined);
        render(tree());
        await screen.findByText("loading");
        await act(async () => { await latest.leaveChat("left"); });
        await screen.findByText("Other chat");
        await act(async () => { finishOld([chat("left", "Left chat")]); });
        expect(screen.getByText("Other chat")).toBeVisible();
        expect(screen.queryByText("Left chat")).toBeNull();
    });

    it("removes only the left chat after success and clears its active selection", async () => {
        listChats.mockResolvedValue([chat("left", "Shared chat"), chat("other", "Other chat")]);
        leaveChat.mockResolvedValue(undefined);
        render(tree());
        await screen.findByText("Shared chat,Other chat");
        act(() => latest.setCurrentChatId("left"));
        await act(async () => { await latest.leaveChat("left"); });
        expect(screen.getByText("Other chat")).toBeVisible();
        expect(latest.currentChatId).toBeNull();
        expect(deleteChat).not.toHaveBeenCalled();
    });

    it("keeps the chat when leaving fails", async () => {
        listChats.mockResolvedValue([chat("left", "Shared chat")]);
        leaveChat.mockRejectedValue(new Error("denied"));
        render(tree());
        await screen.findByText("Shared chat");
        await act(async () => { await expect(latest.leaveChat("left")).rejects.toThrow("denied"); });
        expect(screen.getByText("Shared chat")).toBeVisible();
    });

    it("does not remove an org row when a Personal leave finishes after a workspace switch", async () => {
        let finish!: () => void;
        leaveChat.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
        listChats.mockResolvedValueOnce([chat("same", "Personal chat")]).mockResolvedValueOnce([chat("same", "Org chat")]);
        const view = render(tree());
        await screen.findByText("Personal chat");
        let leaving!: Promise<void>;
        act(() => { leaving = latest.leaveChat("same"); });
        workspace.current = "org-1";
        view.rerender(tree());
        await screen.findByText("Org chat");
        await act(async () => { finish(); await leaving; });
        expect(screen.getByText("Org chat")).toBeVisible();
    });
});

it("never hands pending workflow messages or stale creation callbacks to the next workspace", async () => {
    let context!: ReturnType<typeof useChatHistoryContext>;
    function PendingProbe() {
        const value = useChatHistoryContext();
        useEffect(() => { context = value; });
        return <span>{value.newChatMessages?.[0]?.content ?? "no draft"}</span>;
    }
    listChats.mockResolvedValue([]);
    workspace.current = "firm-a";
    const view = render(<ChatHistoryProvider><PendingProbe /></ChatHistoryProvider>);
    const oldSetter = context.setNewChatMessages;
    act(() => oldSetter([{ role: "user", content: "confidential draft" }]));
    expect(screen.getByText("confidential draft")).toBeInTheDocument();
    let finish!: (value: { id: string }) => void;
    createChat.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let pending!: Promise<string | null>;
    act(() => { pending = context.saveChat(); });
    workspace.current = "firm-b";
    view.rerender(<ChatHistoryProvider><PendingProbe /></ChatHistoryProvider>);
    expect(screen.getByText("no draft")).toBeInTheDocument();
    act(() => oldSetter([{ role: "user", content: "late secret" }]));
    expect(screen.getByText("no draft")).toBeInTheDocument();
    await act(async () => { finish({ id: "old-chat" }); expect(await pending).toBeNull(); });
    expect(context.chats).not.toContainEqual(expect.objectContaining({ id: "old-chat" }));
});
