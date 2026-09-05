import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    ProjectWorkspaceProvider,
    useProjectWorkspace,
} from "./ProjectWorkspace";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    useSelectedLayoutSegments: () => [],
}));

vi.mock("@/app/lib/mikeApi", () => ({
    createTabularReview: vi.fn(),
    deleteProject: vi.fn(),
    getProject: vi.fn(() => new Promise(() => {})),
    getProjectPeople: vi.fn(),
    listProjectChats: vi.fn(),
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

vi.mock("./ProjectPageParts", () => ({
    ProjectPageHeader: ({
        onUploadFiles,
    }: {
        onUploadFiles?: (() => void) | null;
    }) => <button disabled={!onUploadFiles}>Upload</button>,
}));

vi.mock("@/app/components/tabular/NewTRModal", () => ({
    NewTRModal: () => null,
}));
vi.mock("@/app/components/popups/ConfirmPopup", () => ({
    ConfirmPopup: () => null,
}));
vi.mock("@/app/components/popups/OwnerOnlyPopup", () => ({
    OwnerOnlyPopup: () => null,
}));
vi.mock("@/app/components/modals/AccessModal", () => ({
    AccessModal: () => null,
}));
vi.mock("./ProjectDetailsModal", () => ({
    ProjectDetailsModal: () => null,
}));

const uploadFiles = vi.fn();

function RegisterUploadAction() {
    const { setDocumentUploadHeaderAction } = useProjectWorkspace();

    useEffect(() => {
        setDocumentUploadHeaderAction("uploadFiles", uploadFiles);
        return () => setDocumentUploadHeaderAction("uploadFiles", null);
    }, [setDocumentUploadHeaderAction]);

    return null;
}

describe("ProjectWorkspaceProvider", () => {
    it("keeps document upload actions registered on direct project load", async () => {
        render(
            <ProjectWorkspaceProvider projectId="project-1">
                <RegisterUploadAction />
            </ProjectWorkspaceProvider>,
        );

        expect(
            await screen.findByRole("button", { name: "Upload" }),
        ).toBeEnabled();
    });
});
