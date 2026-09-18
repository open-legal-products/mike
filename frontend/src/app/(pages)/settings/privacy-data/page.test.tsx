import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    deleteAllMemories,
    downloadUserExport,
    getUserExportStatus,
    startUserExport,
} from "@/app/lib/mikeApi";
import PrivacyDataPage from "./page";

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

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    MfaVerificationPopup: () => null,
    needsMfaVerification: async () => false,
}));

const mockedStart = vi.mocked(startUserExport);
const mockedStatus = vi.mocked(getUserExportStatus);
const mockedDownload = vi.mocked(downloadUserExport);
const mockedDeleteMemories = vi.mocked(deleteAllMemories);

beforeEach(() => {
    vi.clearAllMocks();
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
        expect(mockedStart).toHaveBeenCalledWith("account");
        expect(mockedStatus).toHaveBeenCalledTimes(2);
    });

    it("surfaces a failed build instead of downloading anything", async () => {
        mockedStart.mockResolvedValue({ export_id: "job-9" });
        mockedStatus.mockResolvedValue({ status: "failed" });

        render(<PrivacyDataPage />);
        const exportButtons = screen.getAllByRole("button", {
            name: "Export",
        });
        await userEvent.click(exportButtons[0]);

        expect(await screen.findByText("Action failed")).toBeInTheDocument();
        expect(
            screen.getByText("Failed to export chats. Please try again."),
        ).toBeInTheDocument();
        expect(mockedStart).toHaveBeenCalledWith("chats");
        expect(mockedDownload).not.toHaveBeenCalled();
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
        expect(mockedStart).toHaveBeenCalledWith("memory-zip");
    });

    it("confirms and deletes app and private-project memory", async () => {
        mockedDeleteMemories.mockResolvedValue();

        render(<PrivacyDataPage />);
        await userEvent.click(
            screen.getByRole("button", { name: "Delete all memory" }),
        );

        expect(screen.getByText("Delete all memory?")).toBeVisible();
        expect(
            screen.getAllByText(/private projects you created/i),
        ).toHaveLength(2);
        const confirmButtons = screen.getAllByRole("button", {
            name: "Delete",
        });
        await userEvent.click(confirmButtons.at(-1)!);

        await waitFor(() => expect(mockedDeleteMemories).toHaveBeenCalledOnce());
    });
});
