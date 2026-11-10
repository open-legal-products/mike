import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    deleteAllChats,
    deleteAllMemories,
    downloadUserExport,
    getUserExportStatus,
    startUserExport,
} from "@/app/lib/mikeApi";
import PrivacyDataPage from "./page";
import { ToastViewportUI, clearToasts } from "@mike/ui";

// The export buttons drive the async job flow: schedule → poll → download.
// These tests pin that wiring (start called with the right type, download
// only after the poll reports done) — the job itself is backend-tested.

vi.mock("@/app/lib/mikeApi", () => ({
    deleteAllChats: vi.fn(),
    deleteAllMemories: vi.fn(),
    deleteAllProjects: vi.fn(),
    deleteAllTabularReviews: vi.fn(),
    startUserExport: vi.fn(),
    getUserExportStatus: vi.fn(),
    downloadUserExport: vi.fn(),
    isMfaRequiredError: () => false,
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        loadChats: vi.fn(),
        setCurrentChatId: vi.fn(),
    }),
}));

// The active workspace, which every "Delete all" is limited to. Null is the
// default outside a provider, where the page deletes in Personal.
const workspaceState = vi.hoisted(() => ({
    workspaceId: null as string | null,
    activeOrganization: null as {
        id: string;
        name: string;
        role?: string;
        allow_member_exports?: boolean;
        allow_member_deletes?: boolean;
    } | null,
    organizations: [] as { id: string; name: string }[] | null,
}));

vi.mock("@/app/contexts/WorkspaceContext", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/app/contexts/WorkspaceContext")
    >()),
    useWorkspace: () => workspaceState,
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: async () => false,
}));

const mockedStart = vi.mocked(startUserExport);
const mockedStatus = vi.mocked(getUserExportStatus);
const mockedDownload = vi.mocked(downloadUserExport);
const mockedDeleteMemories = vi.mocked(deleteAllMemories);
const mockedDeleteChats = vi.mocked(deleteAllChats);

beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.workspaceId = null;
    workspaceState.activeOrganization = null;
    workspaceState.organizations = [];
    // The page shortens its poll interval to 10ms under NODE_ENV=test, so
    // these tests run on real timers (fake timers fight userEvent).
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("privacy-data async exports", () => {
    it("schedules the job, polls to done, then downloads the artifact", async () => {
        mockedStart.mockResolvedValue({ export_id: "job-9" });
        mockedStatus
            .mockResolvedValueOnce({ status: "pending" })
            .mockResolvedValueOnce({
                status: "done",
                filename: "mike-account-export-u1.json",
            });
        mockedDownload.mockResolvedValue({
            blob: new Blob(["{}"], { type: "application/json" }),
            filename: "mike-account-export-u1.json",
        });
        // jsdom has no createObjectURL.
        globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
        globalThis.URL.revokeObjectURL = vi.fn();

        render(<PrivacyDataPage />);
        // All three export buttons are labeled "Export"; render order is
        // chats, tabular reviews, account (see the page's Export data section).
        const exportButtons = screen.getAllByRole("button", {
            name: "Export",
        });
        await userEvent.click(exportButtons[2]);

        await waitFor(() =>
            expect(mockedDownload).toHaveBeenCalledWith("job-9"),
        );
        expect(mockedStart).toHaveBeenCalledWith("account", {
            workspace: "personal",
        });
        expect(mockedStatus).toHaveBeenCalledTimes(2);
    });

    it("surfaces a failed build in a toast instead of downloading anything", async () => {
        const alertSpy = vi
            .spyOn(window, "alert")
            .mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        clearToasts();
        mockedStart.mockResolvedValue({ export_id: "job-9" });
        mockedStatus.mockResolvedValue({ status: "failed" });

        render(
            <>
                <PrivacyDataPage />
                <ToastViewportUI />
            </>,
        );
        const exportButtons = screen.getAllByRole("button", {
            name: "Export",
        });
        await userEvent.click(exportButtons[0]);

        const toast = await screen.findByRole("alert");
        expect(toast).toHaveTextContent("Couldn't export your chats");
        expect(toast).toHaveTextContent(
            "Mike couldn't build the export. Try again, and contact support if it keeps happening.",
        );
        expect(
            screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
        expect(alertSpy).not.toHaveBeenCalled();
        expect(mockedStart).toHaveBeenCalledWith("chats", {
            workspace: "personal",
        });
        expect(mockedDownload).not.toHaveBeenCalled();
        clearToasts();
    });

    it("exports app and project memory as a ZIP archive", async () => {
        mockedStart.mockResolvedValue({ export_id: "job-memory" });
        mockedStatus.mockResolvedValue({
            status: "done",
            filename: "mike-memory-export.zip",
        });
        mockedDownload.mockResolvedValue({
            blob: new Blob(["zip"], { type: "application/zip" }),
            filename: "mike-memory-export.zip",
        });
        globalThis.URL.createObjectURL = vi.fn(() => "blob:memory");
        globalThis.URL.revokeObjectURL = vi.fn();

        render(<PrivacyDataPage />);
        await userEvent.click(
            screen.getByRole("button", { name: "Export memory" }),
        );

        await waitFor(() =>
            expect(mockedDownload).toHaveBeenCalledWith("job-memory"),
        );
        expect(mockedStart).toHaveBeenCalledWith("memory-zip", {
            workspace: "personal",
        });
    });

    it("confirms and deletes app and private-project memory", async () => {
        mockedDeleteMemories.mockResolvedValue();

        render(<PrivacyDataPage />);
        await userEvent.click(
            screen.getByRole("button", { name: "Delete all memory" }),
        );

        // With only Personal there is no other workspace to tell it from.
        expect(screen.getByText("Delete all memory?")).toBeVisible();
        expect(screen.queryByText(/Deletes data in/)).toBeNull();
        expect(screen.queryByText(/other workspaces/)).toBeNull();
        expect(
            screen.getAllByText(/private projects you created/i),
        ).toHaveLength(2);
        const confirmButtons = screen.getAllByRole("button", {
            name: "Delete",
        });
        await userEvent.click(confirmButtons.at(-1)!);

        await waitFor(() =>
            expect(mockedDeleteMemories).toHaveBeenCalledWith("personal"),
        );
    });

    it("names Personal to someone who also belongs to an organization", async () => {
        workspaceState.organizations = [{ id: "org-1", name: "Acme LLP" }];
        mockedDeleteMemories.mockResolvedValue();

        render(<PrivacyDataPage />);
        expect(screen.getByText(/Deletes data in Personal only/)).toBeVisible();
        await userEvent.click(
            screen.getByRole("button", { name: "Delete all memory" }),
        );
        expect(screen.getByText("Delete all memory in Personal?")).toBeVisible();
        expect(
            screen.getByText(/This permanently deletes your Personal memory/),
        ).toBeVisible();
    });

    it("deletes in the active organization only, and says so", async () => {
        workspaceState.workspaceId = "org-1";
        workspaceState.activeOrganization = {
            id: "org-1",
            name: "Acme LLP",
            role: "member",
            allow_member_deletes: true,
        };
        workspaceState.organizations = [workspaceState.activeOrganization];
        mockedDeleteChats.mockResolvedValue();

        render(<PrivacyDataPage />);
        expect(
            screen.getByText(/Deletes data in Acme LLP only/),
        ).toBeVisible();
        // The rows describe what is deleted here, not Personal's private projects.
        expect(
            screen.getByText("Permanently delete your memory in Acme LLP."),
        ).toBeVisible();
        expect(
            screen.queryByText(/private projects you created/i),
        ).not.toBeInTheDocument();

        await userEvent.click(
            screen.getAllByRole("button", { name: "Delete" })[0],
        );
        expect(screen.getByText("Delete all chats in Acme LLP?")).toBeVisible();
        expect(
            screen.getByText(/Your other workspaces are not affected/),
        ).toBeVisible();
        await userEvent.click(
            screen.getAllByRole("button", { name: "Delete" }).at(-1)!,
        );

        await waitFor(() =>
            expect(mockedDeleteChats).toHaveBeenCalledWith("org-1"),
        );
    });

    it("re-asks for confirmation when Retry follows a failed deletion", async () => {
        clearToasts();
        vi.spyOn(console, "error").mockImplementation(() => {});
        mockedDeleteMemories.mockRejectedValue(
            Object.assign(new Error("boom"), { status: 500 }),
        );

        render(
            <>
                <PrivacyDataPage />
                <ToastViewportUI />
            </>,
        );
        await userEvent.click(
            screen.getByRole("button", { name: "Delete all memory" }),
        );
        await userEvent.click(
            screen.getAllByRole("button", { name: "Delete" }).at(-1)!,
        );
        await waitFor(() => expect(mockedDeleteMemories).toHaveBeenCalledOnce());

        await userEvent.click(
            await screen.findByRole("button", { name: "Retry" }),
        );

        // Nothing is erased straight from the toast; the dialog comes back.
        expect(mockedDeleteMemories).toHaveBeenCalledOnce();
        expect(await screen.findByText("Delete all memory?")).toBeVisible();
        clearToasts();
    });

    it("exports the active organization's data when its owners allow members to", async () => {
        workspaceState.workspaceId = "org-1";
        workspaceState.activeOrganization = {
            id: "org-1",
            name: "Acme LLP",
            role: "admin",
            allow_member_exports: true,
            allow_member_deletes: false,
        };
        workspaceState.organizations = [workspaceState.activeOrganization];
        mockedStart.mockRejectedValue(new Error("stop after scheduling"));
        vi.spyOn(console, "error").mockImplementation(() => {});

        render(<PrivacyDataPage />);
        expect(screen.getByText(/Exports data in Acme LLP only/)).toBeVisible();
        // Bulk deletion is not this member's to do here.
        expect(screen.queryByText("Delete data")).toBeNull();

        await userEvent.click(
            screen.getAllByRole("button", { name: "Export" })[0],
        );
        await waitFor(() =>
            expect(mockedStart).toHaveBeenCalledWith("chats", {
                workspace: "org-1",
            }),
        );
    });

    it("explains, rather than offering nothing, when the owners allow neither", async () => {
        workspaceState.workspaceId = "org-1";
        workspaceState.activeOrganization = {
            id: "org-1",
            name: "Acme LLP",
            role: "member",
        };
        workspaceState.organizations = [workspaceState.activeOrganization];

        render(<PrivacyDataPage />);

        expect(screen.getByText("Managed by your organization")).toBeVisible();
        expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    });

    it("offers an organization's owners everything", async () => {
        workspaceState.workspaceId = "org-1";
        workspaceState.activeOrganization = {
            id: "org-1",
            name: "Acme LLP",
            role: "owner",
        };
        workspaceState.organizations = [workspaceState.activeOrganization];

        render(<PrivacyDataPage />);

        expect(screen.getByText("Export data")).toBeVisible();
        expect(screen.getByText("Delete data")).toBeVisible();
    });
});
