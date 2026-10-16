import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    getProjectPeople,
    listOrgMembers,
    getProject,
    listWorkflows,
    uploadProjectDocuments,
    uploadStandaloneDocuments,
    type OrgMember,
} from "@/app/lib/mikeApi";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { UPLOAD_LIMIT_MESSAGES } from "@/shared/api/uploadSessionClient";
import { UNSUPPORTED_DOCUMENT_WARNING_MESSAGE } from "@/app/lib/documentUploadValidation";
import type { Document } from "../shared/types";
import { NewTRModal } from "./NewTRModal";

vi.mock("@/app/lib/mikeApi", async () => {
    // The upload error copy is real shared code; only the network calls are
    // stubbed, so the modal's failure messages are the ones users would see.
    const uploads = await vi.importActual<
        typeof import("@/shared/api/uploadSessionClient")
    >("@/shared/api/uploadSessionClient");
    class MikeApiError extends Error {
        status = 500;
    }
    return {
        MikeApiError,
        UploadBatchError: uploads.UploadBatchError,
        failedUploadMessage: uploads.failedUploadMessage,
        getProject: vi.fn(),
        getProjectPeople: vi.fn(async () => ({ owner: null, members: [] })),
        listOrgMembers: vi.fn(async () => []),
        listWorkflows: vi.fn(async () => []),
        uploadProjectDocuments: vi.fn(),
        uploadStandaloneDocuments: vi.fn(),
    };
});

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {
            tabularModel: "gemini-3.8-flash",
            apiKeys: {
                claude: { configured: false, source: null },
                gemini: { configured: true, source: "user" },
                openai: { configured: false, source: null },
                openrouter: { configured: false, source: null },
                vercel: { configured: false, source: null },
                "opencode-go": { configured: false, source: null },
                courtlistener: { configured: false, source: null },
            },
            openRouterModels: [],
            vercelModels: [],
            openCodeGoModels: [],
        },
        loading: false,
        apiKeysDegraded: false,
    }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));

// The active workspace, set per test: Personal unless a test says otherwise.
const workspace = vi.hoisted(() => ({
    current: null as { id: string; name: string } | null,
}));
vi.mock("@/app/contexts/WorkspaceContext", async () => ({
    ...(await vi.importActual<
        typeof import("@/app/contexts/WorkspaceContext")
    >("@/app/contexts/WorkspaceContext")),
    // Outside a provider, as the other tests here run, plus the one field
    // under test. `workspaceId` stays null so the model picker keeps reading
    // the personal keys stubbed above rather than an organization's.
    useWorkspace: () => ({
        workspaceId: null,
        organizations: null,
        activeOrganization: workspace.current,
        orgApiKeys: null,
        setWorkspace: () => {},
        refreshOrganizations: async () => {},
        refreshOrgApiKeys: async () => {},
    }),
    useWorkspaceOrgId: () => workspace.current?.id,
    useDocumentWorkspace: () => workspace.current?.id,
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
    useOllamaModels: () => [],
}));
vi.mock("@/app/hooks/useConfiguredModels", () => ({
    useConfiguredModels: () => [],
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: ({ tabs }: { tabs?: string[] }) => (
        <div>
            Document directory
            <span data-testid="directory-tabs">{tabs?.join(",")}</span>
        </div>
    ),
}));

describe("NewTRModal", () => {
    afterEach(() => clearToasts());

    beforeEach(() => {
        clearToasts();
        vi.clearAllMocks();
        workspace.current = null;
    });

    it("shares a review started in an organization with its members only", async () => {
        workspace.current = { id: "org-1", name: "Hughes LLP" };
        vi.mocked(listOrgMembers).mockResolvedValue([
            {
                user_id: "u-daniel",
                email: "daniel@firm.test",
                display_name: "Daniel Hughes",
                role: "member",
            },
        ] as OrgMember[]);
        const onAdd = vi.fn();
        render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} />);

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Closing review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        // The organization's members are picked from; there is nowhere to
        // type the address of somebody outside it.
        await waitFor(() =>
            expect(listOrgMembers).toHaveBeenCalledWith("org-1"),
        );
        expect(
            screen.queryByPlaceholderText("Add by email..."),
        ).not.toBeInTheDocument();
        expect(
            document.getElementById("organization-people-picker-description"),
        ).toHaveTextContent(
            "Share this review with members of Hughes LLP.",
        );

        const picker = screen.getByRole("searchbox", { name: "People" });
        await waitFor(() => expect(picker).toBeEnabled());
        fireEvent.focus(picker);
        fireEvent.change(picker, { target: { value: "daniel" } });
        fireEvent.click(
            await screen.findByRole("option", { name: /Daniel Hughes/ }),
        );

        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        expect(onAdd).toHaveBeenCalledWith(
            "Closing review",
            undefined,
            undefined,
            undefined,
            "document",
            "gemini-3.8-flash",
            [
                {
                    email: "daniel@firm.test",
                    display_name: null,
                    role: "editor",
                },
            ],
        );
    });

    it("shows folder grouping on the first screen and excludes Templates", () => {
        const onAdd = vi.fn();
        render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} />);

        expect(screen.getByText("Document grouping")).toBeInTheDocument();
        expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();
        expect(
            screen.getByText(
                "Treat documents in the same folder as one review row",
            ),
        ).toBeInTheDocument();

        const reviewNameInput = screen.getByLabelText("Review name");
        const modelSelect = screen.getByRole("button", {
            name: "Choose model",
        });
        expect(
            reviewNameInput.compareDocumentPosition(modelSelect) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(modelSelect).toHaveClass(
            "h-10",
            "w-full",
            "rounded-xl",
            "liquid-glass-subtle",
        );

        fireEvent.change(reviewNameInput, {
            target: { value: "Closing review" },
        });
        const groupingSwitch = screen.getByRole("switch", {
            name: "Treat documents in the same folder as one review row",
        });
        expect(groupingSwitch).toHaveAttribute("aria-checked", "false");
        fireEvent.click(groupingSwitch);
        expect(groupingSwitch).toHaveAttribute("aria-checked", "true");
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        expect(screen.queryByText("Document directory")).not.toBeInTheDocument();
        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(screen.getByText("Share Access")).toBeInTheDocument();
        const skip = screen.getByRole("button", { name: "Skip" });
        const accessNext = screen.getByRole("button", { name: "Next" });
        expect(skip.parentElement).toBe(accessNext.parentElement);
        expect(skip).toHaveClass("text-gray-500");
        expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
            "bg-blue-600/90",
        );
        fireEvent.click(skip);
        expect(screen.getByText("Document directory")).toBeInTheDocument();
        expect(screen.getByTestId("directory-tabs")).toHaveTextContent(
            "files,projects",
        );
        expect(screen.queryByText("Document grouping")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        expect(onAdd).toHaveBeenCalledWith(
            "Closing review",
            undefined,
            undefined,
            undefined,
            "folder",
            "gemini-3.8-flash",
            [],
        );
    });

    it("prevents duplicate review creation while submission is pending", async () => {
        let finishAdd: (() => void) | undefined;
        const onAdd = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishAdd = resolve;
                }),
        );
        const onClose = vi.fn();
        render(<NewTRModal open onClose={onClose} onAdd={onAdd} />);

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Single review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        expect(onAdd).not.toHaveBeenCalled();
        const create = screen.getByRole("button", { name: "Create" });
        fireEvent.click(create);
        fireEvent.click(create);

        expect(onAdd).toHaveBeenCalledTimes(1);
        expect(
            screen.getByRole("button", { name: "Creating..." }),
        ).toBeDisabled();

        finishAdd?.();
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });

    it("stays open on a partial failure and lets Create retry it", async () => {
        // onAdd resolving with a message means the review exists but part of
        // the request did not happen. Closing here would hide the only account
        // of it, and reporting the generic create failure would be a lie.
        const onAdd = vi
            .fn()
            .mockResolvedValueOnce(
                "Review created, but access was not granted to colleague@firm.test: That address is not in your organization.",
            )
            .mockResolvedValueOnce(undefined);
        const onClose = vi.fn();
        render(<NewTRModal open onClose={onClose} onAdd={onAdd} />);

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Shared review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Create" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Review created, but access was not granted to colleague@firm.test: That address is not in your organization.",
        );
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(onAdd).toHaveBeenCalledTimes(2);
    });

    it("retires Back once the review exists", async () => {
        // The retry reuses the created review, so the earlier steps no longer
        // describe anything that can still change: a Personal → project switch
        // between attempts left the review where it was first created while
        // applying the new scope's assignments to it.
        const onAdd = vi
            .fn()
            .mockResolvedValue(
                "Review created, but access was not granted to colleague@firm.test: That address is not in your organization.",
            );
        render(<NewTRModal open onClose={vi.fn()} onAdd={onAdd} />);

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Shared review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        await screen.findByRole("alert");

        expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    });

    it("stores uploads from a project review in that project", async () => {
        const uploadedDocument = {
            id: "uploaded-document",
            project_id: "project-1",
            filename: "New agreement.pdf",
            file_type: "pdf",
        };
        vi.mocked(uploadProjectDocuments).mockResolvedValue([
            {
                clientId: "client-1",
                filename: "New agreement.pdf",
                status: "completed",
                result: uploadedDocument as Document,
                errorCode: null,
            },
        ]);

        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={vi.fn()}
                projectId="project-1"
                projectDocs={[]}
                projectFolders={[]}
                projectName="Acquisition"
            />,
        );

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Project review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const file = new File(["agreement"], "New agreement.pdf", {
            type: "application/pdf",
        });
        const input =
            document.querySelector<HTMLInputElement>('input[type="file"]');
        fireEvent.change(input!, { target: { files: [file] } });

        await waitFor(() =>
            expect(uploadProjectDocuments).toHaveBeenCalledWith("project-1", [
                { file },
            ]),
        );
        expect(uploadStandaloneDocuments).not.toHaveBeenCalled();
    });

    it("lists the project's people read-only below the inherited access note", async () => {
        vi.mocked(getProjectPeople).mockResolvedValue({
            owner: {
                user_id: "owner-1",
                email: "owner@firm.test",
                display_name: "Olivia Owner",
            },
            members: [
                {
                    user_id: "member-1",
                    email: "editor@firm.test",
                    display_name: "Eddie Editor",
                    role: "editor",
                },
                {
                    user_id: "denied-1",
                    email: "denied@firm.test",
                    display_name: "Denied Member",
                    role: "deny",
                },
            ],
        });
        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={vi.fn()}
                projectId="project-1"
                projectDocs={[]}
                projectFolders={[]}
                projectName="Acquisition"
            />,
        );

        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Project review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));

        const rows = await screen.findAllByRole("listitem");
        expect(getProjectPeople).toHaveBeenCalledWith("project-1");
        expect(rows.map((row) => row.textContent)).toEqual([
            expect.stringContaining("owner@firm.test"),
            expect.stringContaining("editor@firm.test"),
        ]);
        const note = screen.getByText(/Access is inherited from the project/);
        expect(
            note.compareDocumentPosition(screen.getByText("Name")) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(screen.queryByText("Share Access")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /Remove/ }),
        ).not.toBeInTheDocument();
    });

    async function attachFileOnDocumentsStep(filename: string) {
        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={vi.fn()}
                projectId="project-1"
                projectDocs={[]}
                projectFolders={[]}
                projectName="Acquisition"
            />,
        );
        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Project review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        const input =
            document.querySelector<HTMLInputElement>('input[type="file"]');
        fireEvent.change(input!, {
            target: {
                files: [new File(["body"], filename, { type: "application/pdf" })],
            },
        });
    }

    it("names file types the converter cannot read instead of uploading them", async () => {
        await attachFileOnDocumentsStep("notes.xyz");

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
            ),
        );
        expect(uploadProjectDocuments).not.toHaveBeenCalled();
        expect(uploadStandaloneDocuments).not.toHaveBeenCalled();
    });

    it("uploads only the supported files and keeps both warnings", async () => {
        vi.mocked(uploadProjectDocuments).mockResolvedValue([
            {
                clientId: "client-1",
                filename: "Too big.pdf",
                status: "error",
                result: null,
                errorCode: "upload_file_too_large",
            },
        ]);

        render(
            <NewTRModal
                open
                onClose={vi.fn()}
                onAdd={vi.fn()}
                projectId="project-1"
                projectDocs={[]}
                projectFolders={[]}
                projectName="Acquisition"
            />,
        );
        fireEvent.change(screen.getByLabelText("Review name"), {
            target: { value: "Project review" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        const supported = new File(["body"], "Too big.pdf", {
            type: "application/pdf",
        });
        const unsupported = new File(["body"], "notes.xyz");
        const input =
            document.querySelector<HTMLInputElement>('input[type="file"]');
        fireEvent.change(input!, {
            target: { files: [supported, unsupported] },
        });

        await waitFor(() =>
            expect(uploadProjectDocuments).toHaveBeenCalledWith("project-1", [
                { file: supported },
            ]),
        );
        await waitFor(() => {
            const alert = screen.getByRole("alert");
            expect(alert).toHaveTextContent(
                UNSUPPORTED_DOCUMENT_WARNING_MESSAGE,
            );
            expect(alert).toHaveTextContent(
                UPLOAD_LIMIT_MESSAGES.upload_file_too_large!,
            );
        });
    });

    it("reports files that came back as failed outcomes", async () => {
        vi.mocked(uploadProjectDocuments).mockResolvedValue([
            {
                clientId: "client-1",
                filename: "Too big.pdf",
                status: "error",
                result: null,
                errorCode: "upload_file_too_large",
            },
        ]);

        await attachFileOnDocumentsStep("Too big.pdf");

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                UPLOAD_LIMIT_MESSAGES.upload_file_too_large,
            ),
        );
    });

    it("reports a thrown upload batch failure", async () => {
        const { UploadBatchError } = await import("@/app/lib/mikeApi");
        vi.mocked(uploadProjectDocuments).mockRejectedValue(
            new UploadBatchError("batch failed", [
                {
                    clientId: "client-1",
                    filename: "Rejected.pdf",
                    status: "error",
                    result: null,
                    errorCode: null,
                },
            ]),
        );

        await attachFileOnDocumentsStep("Rejected.pdf");

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Rejected.pdf could not be uploaded. Please try again.",
            ),
        );
    });

    it("reports a transport failure without leaking the raw error", async () => {
        vi.mocked(uploadProjectDocuments).mockRejectedValue(
            new TypeError("Failed to fetch"),
        );

        await attachFileOnDocumentsStep("Dropped.pdf");

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "The selected files could not be uploaded. Please try again.",
            ),
        );
        expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    });
});

describe("NewTRModal load failures", () => {
    afterEach(() => clearToasts());

    beforeEach(() => {
        clearToasts();
        vi.clearAllMocks();
    });

    it("says when the workflow templates could not be loaded", async () => {
        vi.mocked(listWorkflows).mockRejectedValue(
            new TypeError("Failed to fetch"),
        );

        render(
            <>
                <NewTRModal open onClose={vi.fn()} onAdd={vi.fn()} />
                <ToastViewportUI />
            </>,
        );

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(
            "Couldn't load the workflow templates",
        );
        expect(alert).not.toHaveTextContent("Failed to fetch");

        vi.mocked(listWorkflows).mockResolvedValue([]);
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(listWorkflows).toHaveBeenCalledTimes(2));
    });

    it("says when the chosen project's files could not be loaded", async () => {
        const user = userEvent.setup();
        vi.mocked(listWorkflows).mockResolvedValue([]);
        vi.mocked(getProject).mockRejectedValue(
            Object.assign(new Error("API error: 500"), { status: 500 }),
        );

        render(
            <>
                <NewTRModal
                    open
                    onClose={vi.fn()}
                    onAdd={vi.fn()}
                    projects={[{ id: "project-1", name: "Acquisition" }] as never}
                />
                <ToastViewportUI />
            </>,
        );

        await user.click(
            screen.getByRole("switch", { name: "Create under a project" }),
        );
        await user.click(screen.getByText("Select project..."));
        await user.click(await screen.findByText("Acquisition"));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't load this project's files");
        expect(alert).not.toHaveTextContent("API error: 500");
    });

    it("ignores a project's file load that fails after another project was chosen", async () => {
        const user = userEvent.setup();
        vi.mocked(listWorkflows).mockResolvedValue([]);
        let failFirst!: (error: unknown) => void;
        vi.mocked(getProject)
            .mockImplementationOnce(
                () =>
                    new Promise((_, reject) => {
                        failFirst = reject;
                    }),
            )
            .mockResolvedValueOnce({
                id: "project-2",
                documents: [],
                folders: [],
            } as never);

        render(
            <>
                <NewTRModal
                    open
                    onClose={vi.fn()}
                    onAdd={vi.fn()}
                    projects={
                        [
                            { id: "project-1", name: "Acquisition" },
                            { id: "project-2", name: "Merger" },
                        ] as never
                    }
                />
                <ToastViewportUI />
            </>,
        );

        await user.click(
            screen.getByRole("switch", { name: "Create under a project" }),
        );
        await user.click(screen.getByText("Select project..."));
        await user.click(await screen.findByText("Acquisition"));
        await user.click(screen.getByText("Acquisition"));
        await user.click(await screen.findByText("Merger"));
        await waitFor(() => expect(getProject).toHaveBeenCalledWith("project-2"));

        failFirst(Object.assign(new Error("API error: 500"), { status: 500 }));
        await new Promise((resolve) => setTimeout(resolve, 50));

        // The failure belongs to a project no longer chosen: no notice, and
        // so no Retry that would switch the picker back to it.
        expect(screen.queryByRole("alert")).toBeNull();
    });
});
