import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    copyDocumentsToWorkflowAssets,
    createWorkflow,
    listOrgMembers,
    lookupUserByEmail,
    MikeApiError,
    shareWorkflow,
    updateWorkflow,
} from "@/app/lib/mikeApi";
import type { Document, Workflow } from "../shared/types";
import { NewWorkflowModal } from "./NewWorkflowModal";

const { useUserProfile } = vi.hoisted(() => ({
    useUserProfile: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    copyDocumentsToWorkflowAssets: vi.fn(),
    createWorkflow: vi.fn(),
    listOrgMembers: vi.fn(),
    lookupUserByEmail: vi.fn(),
    shareWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
}));

vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: ({
        onChange,
    }: {
        onChange: (documents: Document[]) => void;
    }) => (
        <button
            type="button"
            onClick={() =>
                onChange([
                    {
                        id: "document-1",
                        filename: "Precedent.pdf",
                    } as Document,
                ])
            }
        >
            Select asset
        </button>
    ),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));

// `null` is "no workspace provider": the modal behaves as it always has.
const activeWorkspace = vi.hoisted(() => ({
    id: null as string | null,
    name: "Elite Law LLP",
}));
vi.mock("@/app/contexts/WorkspaceContext", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/app/contexts/WorkspaceContext")
    >()),
    useWorkspace: () => ({
        workspaceId: activeWorkspace.id,
        organizations: null,
        activeOrganization:
            activeWorkspace.id && activeWorkspace.id !== "personal"
                ? {
                      id: activeWorkspace.id,
                      name: activeWorkspace.name,
                      role: "member",
                  }
                : null,
        setWorkspace: vi.fn(),
        refreshOrganizations: vi.fn(),
    }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile,
}));

const workflow = {
    id: "workflow-1",
    is_owner: true,
    metadata: {
        title: "Contract Intake",
        type: "assistant",
        language: "English",
        practice: "Litigation",
        jurisdictions: ["Singapore"],
    },
} as Workflow;

describe("NewWorkflowModal editing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        activeWorkspace.id = null;
        vi.mocked(listOrgMembers).mockResolvedValue([]);
        vi.mocked(createWorkflow).mockResolvedValue(workflow);
        vi.mocked(copyDocumentsToWorkflowAssets).mockResolvedValue([]);
        vi.mocked(shareWorkflow).mockResolvedValue(undefined);
        vi.mocked(lookupUserByEmail).mockResolvedValue({
            exists: true,
            email: "counsel@firm.test",
            display_name: "Counsel",
        });
        vi.mocked(updateWorkflow).mockResolvedValue(workflow);
        useUserProfile.mockReturnValue({ profile: { practiceAreas: [] } });
    });

    it("pairs Type with Jurisdiction and presets Practice area from the profile", async () => {
        useUserProfile.mockReturnValue({
            profile: { practiceAreas: ["Litigation"] },
        });
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        const typeField = screen.getByText("Type").parentElement;
        const jurisdictionField =
            screen.getByText("Jurisdiction").parentElement;
        expect(typeField?.parentElement).toBe(jurisdictionField?.parentElement);
        expect(typeField?.parentElement).toHaveClass("grid", "md:grid-cols-2");
        expect(await screen.findByLabelText("Practice area")).toHaveTextContent(
            "Litigation",
        );
    });

    it("disables Save until details change", () => {
        render(
            <NewWorkflowModal
                open
                editWorkflow={workflow}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                onUpdated={vi.fn()}
            />,
        );

        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();

        const title = screen.getByLabelText("Title");
        fireEvent.change(title, { target: { value: "Contract Review" } });
        expect(save).toBeEnabled();

        fireEvent.change(title, { target: { value: "Contract Intake" } });
        expect(save).toBeDisabled();
    });

    it("shows an existing workflow's organisation and its Public setting", async () => {
        const user = userEvent.setup({ delay: null });
        const onUpdated = vi.fn();
        render(
            <NewWorkflowModal
                open
                editWorkflow={{
                    ...workflow,
                    org_id: "org-1",
                    organization_name: "Elite Law LLP",
                    visibility: "private",
                }}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                onUpdated={onUpdated}
            />,
        );

        // Where it lives is fixed: work is not moved between organisations.
        expect(
            document.querySelector('[data-slot="workflow-workspace"]'),
        ).toHaveTextContent("Elite Law LLP");
        const publicToggle = screen.getByRole("button", { name: "Public" });
        expect(publicToggle).toHaveAttribute("aria-pressed", "false");

        await user.click(publicToggle);
        expect(
            screen.getByText(
                "Everyone in Elite Law LLP can open and edit this workflow.",
            ),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() =>
            expect(updateWorkflow).toHaveBeenCalledWith(
                "workflow-1",
                expect.objectContaining({ visibility: "organization" }),
            ),
        );
    });

    it("does not send the Public setting when it was not changed", async () => {
        // Who can open a workflow is its owner's decision. An editor saving
        // a new title must not be refused for a setting they did not touch.
        const user = userEvent.setup({ delay: null });
        render(
            <NewWorkflowModal
                open
                editWorkflow={{
                    ...workflow,
                    org_id: "org-1",
                    organization_name: "Elite Law LLP",
                    visibility: "organization",
                    is_owner: false,
                }}
                onClose={vi.fn()}
                onCreated={vi.fn()}
                onUpdated={vi.fn()}
            />,
        );

        expect(screen.getByRole("button", { name: "Public" })).toBeDisabled();
        const title = screen.getByLabelText("Title");
        await user.clear(title);
        await user.type(title, "Renamed");
        await user.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
        expect(
            vi.mocked(updateWorkflow).mock.calls[0][1],
        ).not.toHaveProperty("visibility");
    });

    it("offers no Public toggle for a personal workflow", () => {
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);
        expect(
            screen.queryByRole("group", { name: "Organisational Access" }),
        ).not.toBeInTheDocument();
    });

    it("creates an assistant workflow only after the Assets screen", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));

        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(screen.getByText("Share Access")).toBeInTheDocument();
        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const skip = screen.getByRole("button", { name: "Skip" });
        const next = screen.getByRole("button", { name: "Next" });
        expect(skip.parentElement).toBe(next.parentElement);
        expect(skip).toHaveClass("text-gray-500");
        expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
            "bg-blue-600/90",
        );

        await user.click(next);
        expect(
            screen.getByRole("dialog", { name: "Add Assets" }),
        ).toBeVisible();
        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(onCreated).toHaveBeenCalledWith({
            ...workflow,
            access_scope: "private",
            organization_name: null,
        });
    });

    it("moves a skipped assistant Access screen to Assets before creating", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Skip" }));
        expect(
            screen.getByRole("dialog", { name: "Add Assets" }),
        ).toBeVisible();
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(shareWorkflow).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalledWith({
            ...workflow,
            access_scope: "private",
            organization_name: null,
        });
    });

    it("copies selected directory files before completing assistant creation", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Select asset" }));
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );

        await waitFor(() =>
            expect(copyDocumentsToWorkflowAssets).toHaveBeenCalledWith(
                "workflow-1",
                ["document-1"],
            ),
        );
        expect(onCreated).toHaveBeenCalled();
        expect(
            vi.mocked(copyDocumentsToWorkflowAssets).mock
                .invocationCallOrder[0],
        ).toBeLessThan(onCreated.mock.invocationCallOrder[0]);
    });

    it("reports a failed asset copy against the workflow that exists", async () => {
        // The copy ran before the grants and outside any try of its own, so a
        // failure came back as "Failed to create workflow" — about a workflow
        // the server had already made — and the retry re-copied everything
        // that had worked.
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        vi.mocked(copyDocumentsToWorkflowAssets).mockRejectedValueOnce(
            new Error("copy failed"),
        );
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Select asset" }));
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );

        expect(
            await screen.findByText(
                "Workflow created, but 1 asset could not be copied. Press Create again to retry the copy.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("Failed to create workflow"),
        ).not.toBeInTheDocument();
        // Held open on the only screen that knows: the row never reached the
        // caller's list.
        expect(onCreated).not.toHaveBeenCalled();

        // The retry reuses the workflow and re-sends only the missing asset.
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(createWorkflow).toHaveBeenCalledTimes(1);
        expect(copyDocumentsToWorkflowAssets).toHaveBeenCalledTimes(2);
    });

    it("copies assets only after the grants have been written", async () => {
        // Grants first: a refused grant stops the submit, and an asset copied
        // before it would have to be redone on the retry.
        const user = userEvent.setup({ delay: null });
        vi.mocked(shareWorkflow).mockRejectedValue(new Error("nope"));
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        await user.type(screen.getByLabelText("Title"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByPlaceholderText("Add by email..."));
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("counsel@firm.test");
        await user.click(screen.getByRole("button", { name: "Add" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Select asset" }));
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );

        expect(
            await screen.findByText(
                /Workflow created, but access was not granted to counsel@firm\.test/,
            ),
        ).toBeInTheDocument();
        expect(copyDocumentsToWorkflowAssets).not.toHaveBeenCalled();
        expect(
            screen.getByText(
                /The 1 selected file is still pending and will be copied when you try again\./,
            ),
        ).toBeInTheDocument();
    });

    it("finishes a tabular workflow on Access without showing Assets", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        await user.click(screen.getByRole("button", { name: "Tabular" }));
        await user.type(screen.getByLabelText("Title"), "Tabular workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));

        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Create workflow" }),
        ).toBeVisible();
        expect(screen.queryByText("Select asset")).not.toBeInTheDocument();
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(copyDocumentsToWorkflowAssets).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalled();
    });

    it("never creates a new workflow from a generic form submission", () => {
        const onCreated = vi.fn();
        render(
            <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
        );

        fireEvent.change(screen.getByLabelText("Title"), {
            target: { value: "New workflow" },
        });
        const form = document.getElementById("workflow-modal-form");
        expect(form).not.toBeNull();

        fireEvent.submit(form!);
        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        fireEvent.submit(form!);

        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();
    });

    it("puts the Public setting last on the details and names the access screen", async () => {
        const user = userEvent.setup({ delay: null });
        activeWorkspace.id = "org-1";
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        // No choosing an organisation: it is the workspace being worked in.
        expect(
            screen.queryByLabelText("Share across Organisation"),
        ).not.toBeInTheDocument();
        const jurisdiction = screen.getByLabelText("Jurisdiction");
        const publicToggle = screen.getByRole("button", { name: "Public" });
        expect(publicToggle).toHaveAttribute("aria-pressed", "false");
        expect(
            jurisdiction.compareDocumentPosition(publicToggle) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        // Private: the access screen is for naming individuals.
        await user.type(screen.getByLabelText("Title"), "Firm workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(
            screen.getByRole("dialog", { name: "People" }),
        ).toBeVisible();
        expect(
            await screen.findByRole("searchbox", { name: "People" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Deny list" }),
        ).not.toBeInTheDocument();

        // Public: everybody is in; what is left is more owners and the
        // deny list.
        await user.click(screen.getByRole("button", { name: "Back" }));
        await user.click(screen.getByRole("button", { name: "Public" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(
            screen.queryByRole("searchbox", { name: "People" }),
        ).not.toBeInTheDocument();
        expect(
            await screen.findByRole("searchbox", { name: "Workflow owners" }),
        ).toBeInTheDocument();
        const denyToggle = await screen.findByRole("button", {
            name: "Deny list",
        });
        expect(denyToggle).toHaveAttribute("aria-expanded", "false");
        await user.click(denyToggle);
        expect(
            screen.getByText(
                "Deny Elite Law LLP members from accessing this workflow, although it is open to everyone else.",
            ),
        ).toBeInTheDocument();
    });

    it("creates an organisation's workflow with the chosen Public setting", async () => {
        const user = userEvent.setup({ delay: null });
        activeWorkspace.id = "org-1";
        render(<NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Tabular" }));
        await user.type(screen.getByLabelText("Title"), "Firm workflow");
        await user.click(screen.getByRole("button", { name: "Public" }));
        while (!screen.queryByRole("button", { name: /^Create/ })) {
            await user.click(screen.getByRole("button", { name: "Next" }));
        }
        await user.click(screen.getByRole("button", { name: /^Create/ }));

        await waitFor(() =>
            expect(createWorkflow).toHaveBeenCalledWith(
                expect.objectContaining({
                    org_id: "org-1",
                    visibility: "organization",
                }),
            ),
        );
    });

    async function reachCreateWithOneRecipient(
        user: ReturnType<typeof userEvent.setup>,
    ) {
        await user.click(screen.getByRole("button", { name: "Tabular" }));
        await user.type(screen.getByLabelText("Title"), "Tabular workflow");
        await user.click(screen.getByRole("button", { name: "Next" }));

        await user.click(screen.getByPlaceholderText("Add by email..."));
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("counsel@firm.test");
        await user.click(screen.getByRole("button", { name: "Add" }));
    }

    it("reports a refused grant against the workflow that was created", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        const onClose = vi.fn();
        vi.mocked(shareWorkflow).mockRejectedValueOnce(
            new MikeApiError({
                message: "Only owners can share this workflow.",
                status: 403,
            }),
        );
        render(
            <NewWorkflowModal
                open
                onClose={onClose}
                onCreated={onCreated}
            />,
        );

        await reachCreateWithOneRecipient(user);
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );

        expect(
            await screen.findByText(
                "Workflow created, but access was not granted to counsel@firm.test: Only owners can share this workflow.",
            ),
        ).toBeVisible();
        expect(createWorkflow).toHaveBeenCalledTimes(1);
        expect(onCreated).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        // Pressing Create again must retry only the grant, against the
        // workflow that already exists.
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
        expect(createWorkflow).toHaveBeenCalledTimes(1);
        expect(shareWorkflow).toHaveBeenCalledTimes(2);
    });

    it("tells the caller to refetch when a created workflow is dismissed unshared", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        vi.mocked(shareWorkflow).mockRejectedValue(
            new MikeApiError({
                message: "Only owners can share this workflow.",
                status: 403,
            }),
        );
        render(
            <NewWorkflowModal open onClose={onClose} onCreated={vi.fn()} />,
        );

        await reachCreateWithOneRecipient(user);
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await screen.findByText(/Workflow created, but access was not granted/);

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledWith(true);
    });

    it("does not ask for a refetch when nothing was created", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        render(
            <NewWorkflowModal open onClose={onClose} onCreated={vi.fn()} />,
        );

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).toHaveBeenCalledWith(false);
    });

    it("refuses to dismiss while a create is in flight", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        vi.mocked(createWorkflow).mockReturnValue(new Promise(() => {}));
        render(
            <NewWorkflowModal open onClose={onClose} onCreated={vi.fn()} />,
        );

        await reachCreateWithOneRecipient(user);
        await user.click(
            screen.getByRole("button", { name: "Create workflow" }),
        );
        await screen.findByRole("button", { name: "Creating…" });

        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onClose).not.toHaveBeenCalled();
    });
});
