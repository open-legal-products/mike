import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
    QuickActionsProvider,
    useQuickActions,
    useQuickActionStore,
} from "../../../word-addin/src/taskpane/lib/quickActionStore";
import type { QuickAction } from "../../../word-addin/src/taskpane/types";

const mocks = vi.hoisted(() => ({
    list: vi.fn<(_workspace: string) => Promise<QuickAction[]>>(),
}));
vi.mock("../../../word-addin/src/taskpane/api/mikeApi", () => ({
    listQuickActions: mocks.list,
}));

beforeEach(() => {
    mocks.list.mockReset();
    mocks.list.mockResolvedValue([]);
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
        resolve = finish;
    });
    return { promise, resolve };
}

function action(id: string, prompt: string): QuickAction {
    return {
        id,
        name: prompt,
        prompt,
        workflow_id: "workflow-1",
        workflow: { id: "workflow-1", title: "Review" },
        document_upload: false,
        surface: "word",
        enabled: true,
        sort_order: 0,
    };
}

function List({ saving }: { saving?: Promise<QuickAction> }) {
    const { save } = useQuickActionStore();
    const actions = useQuickActions();
    return (
        <>
            {saving && (
                <button type="button" onClick={() => void saving.then(save)}>
                    Save action
                </button>
            )}
            <ul>
                {actions.map((row) => (
                    <li key={row.id}>{row.prompt}</li>
                ))}
            </ul>
        </>
    );
}

function pane(accountId: string, workspaceId: string, saving?: Promise<QuickAction>) {
    return (
        <QuickActionsProvider key={`${accountId}/${workspaceId}`} workspaceId={workspaceId}>
            <List saving={saving} />
        </QuickActionsProvider>
    );
}

it("keeps delayed writes in the account and workspace where they started", async () => {
    const saving = deferred<QuickAction>();
    const { rerender } = render(pane("user-a", "team-a", saving.promise));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith("team-a"));
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));

    rerender(pane("user-a", "team-b"));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith("team-b"));
    await act(async () => saving.resolve(action("a", "Team A draft")));
    expect(screen.queryByText("Team A draft")).not.toBeInTheDocument();

    rerender(pane("user-b", "team-a"));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
    expect(screen.queryByText("Team A draft")).not.toBeInTheDocument();
});

it("discards an old list even after switching back to the same workspace", async () => {
    const oldList = deferred<QuickAction[]>();
    mocks.list
        .mockReturnValueOnce(oldList.promise)
        .mockResolvedValueOnce([action("b", "Team B draft")])
        .mockResolvedValueOnce([action("a", "Current Team A draft")]);
    const { rerender } = render(pane("user-a", "team-a"));

    rerender(pane("user-a", "team-b"));
    expect(await screen.findByText("Team B draft")).toBeInTheDocument();
    rerender(pane("user-a", "team-a"));
    expect(await screen.findByText("Current Team A draft")).toBeInTheDocument();
    expect(screen.queryByText("Team B draft")).not.toBeInTheDocument();

    await act(async () => oldList.resolve([action("a", "Old Team A draft")]));
    expect(screen.getByText("Current Team A draft")).toBeInTheDocument();
    expect(screen.queryByText("Old Team A draft")).not.toBeInTheDocument();
});

it("preserves a save that completes before the initial list", async () => {
    const list = deferred<QuickAction[]>();
    const saving = deferred<QuickAction>();
    mocks.list.mockReturnValueOnce(list.promise);
    render(pane("user-a", "team-a", saving.promise));
    fireEvent.click(screen.getByRole("button", { name: "Save action" }));

    await act(async () => saving.resolve(action("a", "Saved draft")));
    await act(async () => list.resolve([action("a", "Old draft"), action("b", "Other draft")]));

    expect(screen.getByText("Saved draft")).toBeInTheDocument();
    expect(screen.getByText("Other draft")).toBeInTheDocument();
    expect(screen.queryByText("Old draft")).not.toBeInTheDocument();
});
