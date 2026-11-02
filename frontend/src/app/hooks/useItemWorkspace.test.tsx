import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useItemWorkspace } from "./useItemWorkspace";

// Opening an item opens its workspace: once per item, only into a workspace
// the person belongs to, and with a notice.

const state = vi.hoisted(() => ({
    workspaceId: "personal" as string | null,
    organizations: [] as { id: string; name: string }[] | null,
    setWorkspace: vi.fn(),
    showToast: vi.fn(),
}));

vi.mock("@/app/contexts/WorkspaceContext", () => ({
    PERSONAL_WORKSPACE: "personal",
    PERSONAL_WORKSPACE_LABEL: "Personal",
    useWorkspace: () => ({
        workspaceId: state.workspaceId,
        organizations: state.organizations,
        setWorkspace: state.setWorkspace,
    }),
}));
vi.mock("@/shared/lib/toastStore", () => ({ showToast: state.showToast }));

type Args = { itemId?: string | null; orgId?: string | null };
const open = (initialProps: Args) =>
    renderHook(({ itemId, orgId }: Args) => useItemWorkspace(itemId, orgId), {
        initialProps,
    });

beforeEach(() => {
    vi.clearAllMocks();
    state.workspaceId = "personal";
    state.organizations = [
        { id: "org-1", name: "Elite Law LLP" },
        { id: "org-2", name: "Beta Chambers" },
    ];
});

describe("useItemWorkspace", () => {
    it("switches to the organization an item belongs to, and says so", () => {
        open({ itemId: "project-1", orgId: "org-1" });

        expect(state.setWorkspace).toHaveBeenCalledExactlyOnceWith("org-1");
        expect(state.showToast).toHaveBeenCalledExactlyOnceWith({
            tone: "info",
            title: "Switched to Elite Law LLP",
            message: "What you opened belongs to this workspace.",
            // Gone sooner than an ordinary notice.
            durationMs: 2500,
            dedupeKey: "workspace-switch",
        });
    });

    it("switches to Personal for a personal item opened from an organization", () => {
        state.workspaceId = "org-1";
        open({ itemId: "chat-1", orgId: null });

        expect(state.setWorkspace).toHaveBeenCalledExactlyOnceWith("personal");
        expect(state.showToast).toHaveBeenCalledWith(
            expect.objectContaining({ title: "Switched to Personal" }),
        );
    });

    it("does nothing when the item is already in the active workspace", () => {
        state.workspaceId = "org-1";
        open({ itemId: "project-1", orgId: "org-1" });

        expect(state.setWorkspace).not.toHaveBeenCalled();
        expect(state.showToast).not.toHaveBeenCalled();
    });

    it("waits until the item's workspace is known", () => {
        const view = open({ itemId: "project-1", orgId: undefined });
        expect(state.setWorkspace).not.toHaveBeenCalled();

        view.rerender({ itemId: "project-1", orgId: "org-2" });
        expect(state.setWorkspace).toHaveBeenCalledExactlyOnceWith("org-2");
    });

    it("waits until the person's organizations are known", () => {
        state.organizations = null;
        const view = open({ itemId: "project-1", orgId: "org-1" });
        expect(state.setWorkspace).not.toHaveBeenCalled();

        state.organizations = [{ id: "org-1", name: "Elite Law LLP" }];
        view.rerender({ itemId: "project-1", orgId: "org-1" });
        expect(state.setWorkspace).toHaveBeenCalledExactlyOnceWith("org-1");
    });

    it("never switches to an organization the person does not belong to", () => {
        open({ itemId: "project-1", orgId: "someone-elses" });

        expect(state.setWorkspace).not.toHaveBeenCalled();
        expect(state.showToast).not.toHaveBeenCalled();
    });

    it("leaves the workspace alone once the item is open: the switcher is the person's", () => {
        const view = open({ itemId: "project-1", orgId: "org-1" });
        expect(state.setWorkspace).toHaveBeenCalledTimes(1);

        // The switch is made; then they choose another workspace themselves.
        state.workspaceId = "org-1";
        view.rerender({ itemId: "project-1", orgId: "org-1" });
        state.workspaceId = "org-2";
        view.rerender({ itemId: "project-1", orgId: "org-1" });

        expect(state.setWorkspace).toHaveBeenCalledTimes(1);
        expect(state.showToast).toHaveBeenCalledTimes(1);
    });

    it("does not pull somebody back who switched away from an item that was already theirs", () => {
        state.workspaceId = "org-1";
        const view = open({ itemId: "project-1", orgId: "org-1" });

        state.workspaceId = "personal";
        view.rerender({ itemId: "project-1", orgId: "org-1" });

        expect(state.setWorkspace).not.toHaveBeenCalled();
    });

    it("follows the next item opened in the same place", () => {
        const view = open({ itemId: "chat-1", orgId: null });
        expect(state.setWorkspace).not.toHaveBeenCalled();

        view.rerender({ itemId: "chat-2", orgId: "org-1" });
        expect(state.setWorkspace).toHaveBeenCalledExactlyOnceWith("org-1");
    });

    it("stays out of it where there is no item, or no workspaces to switch between", () => {
        open({ itemId: null, orgId: "org-1" });
        state.workspaceId = null;
        open({ itemId: "project-1", orgId: "org-1" });

        expect(state.setWorkspace).not.toHaveBeenCalled();
    });
});
