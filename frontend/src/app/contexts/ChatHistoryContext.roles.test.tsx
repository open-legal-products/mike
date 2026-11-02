import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The sidebar's role gates read each row through roleFrom(), which fails
// closed to viewer when a row carries neither is_owner nor access_role. The
// rows the overview RPC serves always carry both — but the OPTIMISTIC row
// saveChat prepends is built by hand, and a bare row locked the creator out
// of renaming and deleting their own brand-new thread until a reload.

const { createChat, listChats, renameChatApi } = vi.hoisted(() => ({
    createChat: vi.fn(),
    listChats: vi.fn(),
    renameChatApi: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    createChat: (...args: unknown[]) => createChat(...args),
    listChats: (...args: unknown[]) => listChats(...args),
    renameChat: (...args: unknown[]) => renameChatApi(...args),
    deleteChat: vi.fn(async () => undefined),
}));
// One stable user object: the provider reloads the chat list whenever the
// user identity changes, and a fresh object per render would wipe the
// optimistic row this test exists to observe.
const STABLE_USER = { id: "u1", email: "a@firm.test" };
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: STABLE_USER }),
}));

import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";
import { roleFrom } from "@/app/lib/permissions";
import { beginAssistantTurn } from "@/app/lib/assistantTurns";

function Probe() {
    const { chats, saveChat, renameChat, loadMoreChats, hasMoreChats } =
        useChatHistoryContext();
    const optimistic = chats?.find((c) => c.id === "chat-9");
    return (
        <div>
            <button onClick={() => void saveChat()}>save</button>
            <button onClick={() => void saveChat("p1", "editor")}>
                save in project as editor
            </button>
            <button onClick={() => void saveChat("p1", "owner")}>
                save in project as owner
            </button>
            <button onClick={() => void saveChat("p1")}>
                save in project with unknown role
            </button>
            <button
                onClick={() => {
                    renameChat("chat-9", "New title").catch(() => {
                        document.title = "rename-rejected";
                    });
                }}
            >
                rename
            </button>
            <button onClick={() => void loadMoreChats()}>load more</button>
            <span data-testid="loaded">{String(chats !== null)}</span>
            <span data-testid="role">
                {optimistic ? roleFrom(optimistic) : "absent"}
            </span>
            <span data-testid="is-owner">
                {String(optimistic?.is_owner ?? "absent")}
            </span>
            <output data-testid="chat-order">
                {chats?.map((chat) => chat.id).join(",") ?? "loading"}
            </output>
            <output data-testid="chat-updated">
                {chats?.find((chat) => chat.id === "older")?.updated_at ?? ""}
            </output>
            <output data-testid="has-more">{String(hasMoreChats)}</output>
        </div>
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    createChat.mockResolvedValue({ id: "chat-9" });
    listChats.mockResolvedValue([]);
    renameChatApi.mockResolvedValue(undefined);
});

async function renderProbe() {
    render(
        <ChatHistoryProvider>
            <Probe />
        </ChatHistoryProvider>,
    );
    await waitFor(() =>
        expect(screen.getByTestId("loaded")).toHaveTextContent("true"),
    );
}

describe("saveChat's optimistic row", () => {
    it("carries the creator's owner standing, as the server would serve it", async () => {
        render(
            <ChatHistoryProvider>
                <Probe />
            </ChatHistoryProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loaded")).toHaveTextContent("true"),
        );

        fireEvent.click(screen.getByText("save"));

        // What the gates actually consume is the derived role: a bare row
        // resolves to viewer, and the creator is refused their own thread.
        await waitFor(() =>
            expect(screen.getByTestId("role")).toHaveTextContent("owner"),
        );
        expect(screen.getByTestId("is-owner")).toHaveTextContent("true");
    });

    // A PROJECT chat's role is not the creator's to claim: the server derives
    // it from the project (ensureSharedRowAccess). Stamping owner offered an
    // editor the Delete item in the sidebar, and the server answered 403.
    it("stamps a project chat with the caller's project role, not owner", async () => {
        await renderProbe();

        fireEvent.click(screen.getByText("save in project as editor"));

        await waitFor(() =>
            expect(screen.getByTestId("role")).toHaveTextContent("editor"),
        );
        expect(screen.getByTestId("is-owner")).toHaveTextContent("false");
    });

    it("keeps owner standing for a project owner", async () => {
        await renderProbe();

        fireEvent.click(screen.getByText("save in project as owner"));

        await waitFor(() =>
            expect(screen.getByTestId("role")).toHaveTextContent("owner"),
        );
        expect(screen.getByTestId("is-owner")).toHaveTextContent("true");
    });

    it("falls back to editor, not owner, when the project role is unknown", async () => {
        await renderProbe();

        fireEvent.click(screen.getByText("save in project with unknown role"));

        await waitFor(() =>
            expect(screen.getByTestId("role")).toHaveTextContent("editor"),
        );
        expect(screen.getByTestId("is-owner")).toHaveTextContent("false");
    });

    it("rethrows a refused rename so the row can say why", async () => {
        // The old bare catch made a refused rename a silent success from the
        // caller's point of view: title changed on screen, then quietly
        // reverted on reload. The context restores the list AND rethrows.
        renameChatApi.mockRejectedValue(new Error("403"));
        render(
            <ChatHistoryProvider>
                <Probe />
            </ChatHistoryProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loaded")).toHaveTextContent("true"),
        );
        fireEvent.click(screen.getByText("save"));
        await waitFor(() =>
            expect(screen.getByTestId("role")).toHaveTextContent("owner"),
        );

        const callsBefore = listChats.mock.calls.length;
        fireEvent.click(screen.getByText("rename"));

        await waitFor(() => expect(document.title).toBe("rename-rejected"));
        // The reload that snaps the optimistic title back still happens.
        expect(listChats.mock.calls.length).toBeGreaterThan(callsBefore);
    });
});

describe("chat activity ordering", () => {
    it("moves a chat to the front and refreshes its time when a turn updates", async () => {
        listChats.mockResolvedValue([
            {
                id: "newer",
                project_id: null,
                user_id: "u1",
                title: "Newer",
                created_at: "2026-09-20T12:00:00Z",
                updated_at: "2026-09-20T12:00:00Z",
            },
            {
                id: "older",
                project_id: null,
                user_id: "u1",
                title: "Older",
                created_at: "2026-09-10T12:00:00Z",
                updated_at: "2026-09-10T12:00:00Z",
            },
        ]);
        await renderProbe();

        expect(screen.getByTestId("chat-order")).toHaveTextContent(
            "newer,older",
        );
        const turn = beginAssistantTurn("older", {
            userMessage: { role: "user", content: "Continue" },
            assistant: { role: "assistant", content: "" },
            cancel: vi.fn(),
        });

        await waitFor(() =>
            expect(screen.getByTestId("chat-order")).toHaveTextContent(
                "older,newer",
            ),
        );
        expect(screen.getByTestId("chat-updated").textContent).not.toBe(
            "2026-09-10T12:00:00Z",
        );
        act(() => turn.finish());
    });

    it("loads the next page from the last server row instead of the mutable list length", async () => {
        const initial = Array.from({ length: 21 }, (_, index) => ({
            id: `chat-${index + 1}`,
            project_id: null,
            user_id: "u1",
            title: `Chat ${index + 1}`,
            created_at: new Date(
                Date.UTC(2026, 8, 21, 0, 0, 21 - index),
            ).toISOString(),
            updated_at: new Date(
                Date.UTC(2026, 8, 21, 0, 0, 21 - index),
            ).toISOString(),
        }));
        listChats
            .mockResolvedValueOnce(initial)
            .mockResolvedValueOnce([
                {
                    id: "chat-21",
                    project_id: null,
                    user_id: "u1",
                    title: "Chat 21",
                    created_at: "2026-09-20T00:00:00.000Z",
                    updated_at: "2026-09-20T00:00:00.000Z",
                },
            ]);
        await renderProbe();

        expect(screen.getByTestId("has-more")).toHaveTextContent("true");
        fireEvent.click(screen.getByText("load more"));

        await waitFor(() => expect(listChats).toHaveBeenCalledTimes(2));
        expect(listChats).toHaveBeenLastCalledWith({
            limit: 11,
            beforeUpdatedAt: initial[19].updated_at,
            beforeId: "chat-20",
        });
    });
});
