import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    deleteProject,
    getProject,
    getProjectAccess,
} from "@/app/lib/mikeApi";
import { ProjectWorkspaceProvider } from "./ProjectWorkspace";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSelectedLayoutSegments: () => [],
}));

vi.mock("@/app/lib/mikeApi", () => ({
    createTabularReview: vi.fn(),
    deleteProject: vi.fn(),
    getProject: vi.fn(),
    getProjectAccess: vi.fn(),
    getProjectPeople: vi.fn(async () => ({ owner: null, members: [] })),
    grantProjectAccess: vi.fn(),
    listProjectChats: vi.fn(async () => []),
    revokeProjectAccess: vi.fn(),
    setProjectMemoryEnabled: vi.fn(),
    updateProject: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { displayName: "User" } }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat: vi.fn() }),
}));

// Stand-ins that expose the two entry points this file exercises.
vi.mock("./ProjectPageParts", () => ({
    ProjectPageHeader: ({
        onDeleteProject,
        onOpenAccess,
    }: {
        onDeleteProject: () => void;
        onOpenAccess: () => void;
    }) => (
        <>
            <button type="button" onClick={onDeleteProject}>
                Delete project
            </button>
            <button type="button" onClick={onOpenAccess}>
                Open access
            </button>
        </>
    ),
}));

vi.mock("@/app/components/popups/ConfirmPopup", () => ({
    ConfirmPopup: ({
        open,
        onConfirm,
    }: {
        open: boolean;
        onConfirm: () => void;
    }) =>
        open ? (
            <button type="button" onClick={onConfirm}>
                Confirm delete
            </button>
        ) : null,
}));

vi.mock("@/app/components/popups/OwnerOnlyPopup", () => ({
    OwnerOnlyPopup: () => null,
}));

vi.mock("@/app/components/modals/AccessModal", () => ({
    AccessModal: ({
        open,
        access,
    }: {
        open: boolean;
        access: { grants: unknown[]; grantsUnavailable?: boolean };
    }) =>
        open ? (
            <div data-testid="access-modal">
                {access.grantsUnavailable
                    ? "Access list unavailable"
                    : `${access.grants.length} people with access`}
            </div>
        ) : null,
}));

vi.mock("./ProjectDetailsModal", () => ({
    ProjectDetailsModal: () => null,
}));

vi.mock("@/app/components/tabular/NewTRModal", () => ({
    NewTRModal: () => null,
}));

const project = {
    id: "project-1",
    name: "Acme merger",
    is_owner: true,
    access_role: "owner",
    documents: [],
    folders: [],
};

describe("ProjectWorkspaceProvider failures", () => {
    beforeEach(() => {
        clearToasts();
        vi.clearAllMocks();
        vi.mocked(getProject).mockResolvedValue(
            project as unknown as Awaited<ReturnType<typeof getProject>>,
        );
    });

    afterEach(() => {
        clearToasts();
    });

    it("says a project delete failed and offers a Retry", async () => {
        // The dialog used to drop back to its resting state with the project
        // still there, which reads as "nothing happened".
        vi.mocked(deleteProject).mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        render(
            <ProjectWorkspaceProvider projectId="project-1">
                <ToastViewportUI />
            </ProjectWorkspaceProvider>,
        );

        await user.click(
            await screen.findByRole("button", { name: "Delete project" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Confirm delete" }),
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't delete this project");

        vi.mocked(deleteProject).mockClear();
        await user.click(within(alert).getByRole("button", { name: "Retry" }));
        await waitFor(() =>
            expect(deleteProject).toHaveBeenCalledWith("project-1"),
        );
    });

    it("marks the access list unavailable instead of showing an empty one", async () => {
        // An empty grant list reads as "nobody has access", which is a
        // different fact from "the list did not load".
        vi.mocked(getProjectAccess).mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        render(
            <ProjectWorkspaceProvider projectId="project-1">
                <ToastViewportUI />
            </ProjectWorkspaceProvider>,
        );

        await user.click(
            await screen.findByRole("button", { name: "Open access" }),
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't load who has access");
        expect(await screen.findByTestId("access-modal")).toHaveTextContent(
            "Access list unavailable",
        );

        // The failed load does not re-fire on every render.
        const attempts = vi.mocked(getProjectAccess).mock.calls.length;
        expect(attempts).toBe(1);

        vi.mocked(getProjectAccess).mockResolvedValue({
            grants: [{ email: "someone@example.com", role: "editor" }],
        } as unknown as Awaited<ReturnType<typeof getProjectAccess>>);
        await user.click(within(alert).getByRole("button", { name: "Retry" }));
        await waitFor(() =>
            expect(screen.getByTestId("access-modal")).toHaveTextContent(
                "1 people with access",
            ),
        );
    });

    it("says the project itself could not be loaded", async () => {
        vi.mocked(getProject).mockRejectedValue(new Error("boom"));
        render(
            <ProjectWorkspaceProvider projectId="project-1">
                <ToastViewportUI />
            </ProjectWorkspaceProvider>,
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Couldn't load this project",
        );
    });
});
