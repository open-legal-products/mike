import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getTabularReview, updateTabularReview } from "@/app/lib/mikeApi";
import type { TabularReview } from "@/app/components/shared/types";
import { TRView } from "./TabularReviewView";

// The grid, side panels and chat are out of scope. This file pins the ONE
// question the details dialog has to answer consistently: which role may
// edit a review's details, asked at the menu, at the dialog, and at the save.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    MikeApiError: class MikeApiError extends Error {},
    clearTabularCells: vi.fn(),
    deleteTabularReview: vi.fn(),
    getTabularReview: vi.fn(),
    getProject: vi.fn(),
    getTabularReviewPeople: vi.fn(async () => ({ owner: null, members: [] })),
    // #383's review-model toggle loads the local-model catalog on render.
    getOllamaModels: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
    regenerateTabularCell: vi.fn(),
    streamTabularGeneration: vi.fn(),
    updateTabularReview: vi.fn(async (_id: string, patch: unknown) => patch),
    uploadReviewDocument: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { apiKeys: {} }, apiKeysDegraded: false }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("../assistant/ModelToggle", () => ({
    ModelToggle: ({
        onChange,
    }: {
        onChange: (model: string) => void;
    }) => (
        <button onClick={() => onChange("model-next")}>change model</button>
    ),
}));
vi.mock("./TRTable", () => ({ TRTable: () => <div /> }));
vi.mock("./TRSidePanel", () => ({ TRSidePanel: () => null }));
vi.mock("./TRChatPanel", () => ({ TRChatPanel: () => null }));
vi.mock("./AddColumnModal", () => ({ AddColumnModal: () => null }));
vi.mock("./TRWorkflowModal", () => ({ TRWorkflowModal: () => null }));
vi.mock("../modals/AddDocumentsModal", () => ({ AddDocumentsModal: () => null }));
vi.mock("../modals/PeopleModal", () => ({ PeopleModal: () => null }));
vi.mock("../popups/ApiKeyMissingPopup", () => ({ ApiKeyMissingPopup: () => null }));
vi.mock("./TabularReviewDetailsModal", () => ({
    TabularReviewDetailsModal: ({
        open,
        canEdit,
        onSave,
    }: {
        open: boolean;
        canEdit: boolean;
        onSave: (values: { title: string; projectId?: string | null }) => void;
    }) =>
        open ? (
            <div>
                <span data-testid="details-can-edit">{String(canEdit)}</span>
                <button onClick={() => onSave({ title: "Renamed" })}>
                    save details
                </button>
                <button onClick={() => onSave({ title: "T", projectId: "p9" })}>
                    move to p9
                </button>
            </div>
        ) : null,
}));

function review(over: Partial<TabularReview>): TabularReview {
    return {
        id: "r1",
        project_id: null,
        user_id: "someone-else",
        title: "Diligence",
        columns_config: [],
        document_ids: [],
        shared_with: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...over,
    } as TabularReview;
}

function mockDetail(over: Partial<TabularReview>) {
    vi.mocked(getTabularReview).mockResolvedValue({
        review: review(over),
        cells: [],
        rows: [],
        documents: [],
    });
}

async function openActionsMenu() {
    await waitFor(() =>
        expect(screen.getByLabelText("Actions")).toBeInTheDocument(),
    );
    fireEvent.pointerDown(
        screen.getByLabelText("Actions"),
        new MouseEvent("pointerdown", { bubbles: true }),
    );
    fireEvent.click(screen.getByLabelText("Actions"));
    await waitFor(() =>
        expect(screen.getByText("Edit details")).toBeInTheDocument(),
    );
}

describe("TabularReviewView details gate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
            matches: true,
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
    });

    it("lets a member open and save details, matching the server's PATCH", async () => {
        // PATCH /tabular-review/:id gates title on content.edit — 403 "Only a
        // review member can change review settings". The menu used to demand
        // access.manage, so a member was refused at the door for a save the
        // server would have accepted.
        mockDetail({ access_role: "member" });
        render(<TRView reviewId="r1" />);

        await openActionsMenu();
        fireEvent.click(screen.getByText("Edit details"));

        expect(screen.getByTestId("details-can-edit")).toHaveTextContent("true");
        fireEvent.click(screen.getByText("save details"));
        await waitFor(() =>
            expect(updateTabularReview).toHaveBeenCalledWith("r1", {
                title: "Renamed",
            }),
        );
    });

    it("refuses a viewer with the member tier, not the admin one", async () => {
        mockDetail({ access_role: "viewer" });
        render(<TRView reviewId="r1" />);

        await openActionsMenu();
        fireEvent.click(screen.getByText("Edit details"));

        expect(
            await screen.findByText(
                "Only a member can edit tabular review details.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByTestId("details-can-edit")).not.toBeInTheDocument();
    });

    it("refuses a non-creator admin the project move the server reserves for the creator", async () => {
        // `creatorScopedAllowed` — the review's creator, or an admin only once
        // the creator's account is gone. Gating this on access.manage let an
        // admin who did not create the review through to a 403.
        mockDetail({ access_role: "admin", user_id: "someone-else" });
        render(<TRView reviewId="r1" />);

        await openActionsMenu();
        fireEvent.click(screen.getByText("Edit details"));
        fireEvent.click(screen.getByText("move to p9"));

        expect(
            await screen.findByText(
                "Only the person who created this review can move it to another project.",
            ),
        ).toBeInTheDocument();
        expect(updateTabularReview).not.toHaveBeenCalled();
    });

    it("lets the review's creator move it", async () => {
        mockDetail({ access_role: "member", user_id: "me" });
        render(<TRView reviewId="r1" />);

        await openActionsMenu();
        fireEvent.click(screen.getByText("Edit details"));
        fireEvent.click(screen.getByText("move to p9"));

        await waitFor(() =>
            expect(updateTabularReview).toHaveBeenCalledWith("r1", {
                title: "T",
                project_id: "p9",
            }),
        );
    });

    it("lets an admin move a review whose creator's account is gone", async () => {
        mockDetail({ access_role: "admin", user_id: null as unknown as string });
        render(<TRView reviewId="r1" />);

        await openActionsMenu();
        fireEvent.click(screen.getByText("Edit details"));
        fireEvent.click(screen.getByText("move to p9"));

        await waitFor(() =>
            expect(updateTabularReview).toHaveBeenCalledWith("r1", {
                title: "T",
                project_id: "p9",
            }),
        );
    });

    it("lets an org admin change the model of a review they did not create", async () => {
        // The server gates `model` in the same content.edit arm as the title.
        // The old gate was bare `is_owner === false` — the file's last
        // leftover of the ownership model — which refused admins and members
        // a change the server accepts, with admin-tier popup copy.
        mockDetail({ access_role: "admin", is_owner: false });
        render(<TRView reviewId="r1" />);

        await waitFor(() =>
            expect(screen.getByText("change model")).toBeInTheDocument(),
        );
        fireEvent.click(screen.getByText("change model"));

        await waitFor(() =>
            expect(updateTabularReview).toHaveBeenCalledWith("r1", {
                model: "model-next",
            }),
        );
    });

    it("refuses a viewer's model change with the member tier", async () => {
        mockDetail({ access_role: "viewer", is_owner: false });
        render(<TRView reviewId="r1" />);

        await waitFor(() =>
            expect(screen.getByText("change model")).toBeInTheDocument(),
        );
        fireEvent.click(screen.getByText("change model"));

        expect(
            await screen.findByText(/Only a member can change the tabular review model/,
            ),
        ).toBeInTheDocument();
        expect(updateTabularReview).not.toHaveBeenCalled();
    });
});
