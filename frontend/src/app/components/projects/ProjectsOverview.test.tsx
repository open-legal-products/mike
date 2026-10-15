import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsOverview } from "./ProjectsOverview";

const {
    activeTab,
    projectRows,
    retrySpy,
    setActiveTab,
    usePaginatedProjectsSpy,
    workspace,
} = vi.hoisted(() => ({
    activeTab: { current: "all" as string },
    projectRows: { current: [] as Record<string, unknown>[] },
    retrySpy: vi.fn(),
    setActiveTab: vi.fn(),
    usePaginatedProjectsSpy: vi.fn(),
    workspace: { current: "org-1" },
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => ({ get: () => null }),
}));

vi.mock("@/app/hooks/useQueryParamTab", () => ({
    useQueryParamTab: (tabs: string[], defaultTab: string) => [
        tabs.includes(activeTab.current) ? activeTab.current : defaultTab,
        setActiveTab,
    ],
}));

vi.mock("@/app/hooks/usePaginatedProjects", () => ({
    usePaginatedProjects: (options: unknown) => {
        usePaginatedProjectsSpy(options);
        const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
        return {
            projects: projectRows.current,
            setProjects: vi.fn(),
            loading: false,
            loadingMore: false,
            hasMore: false,
            error: null,
            loadMoreError: null,
            loadMore: vi.fn(),
            retry: retrySpy,
            selectedProjectIds,
            setSelectedProjectIds,
            selectAllMatching: vi.fn(),
            getProjectOwnerId: vi.fn(),
        };
    },
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "user-1" },
        isAuthenticated: true,
        authLoading: false,
    }),
}));

vi.mock("@/app/contexts/WorkspaceContext", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/contexts/WorkspaceContext")>()),
    useWorkspaceParam: () => workspace.current,
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getProjectFilterOptions: vi.fn(() => new Promise(() => {})),
    setProjectMemoryEnabled: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
}));

vi.mock("./NewProjectModal", () => ({
    NewProjectModal: ({
        open,
        onClose,
    }: {
        open: boolean;
        onClose: (createdWithoutHandover?: boolean) => void;
    }) =>
        open ? (
            <div>
                <button onClick={() => onClose(true)}>
                    close after partial create
                </button>
                <button onClick={() => onClose()}>close untouched</button>
            </div>
        ) : null,
}));
vi.mock("./ProjectDetailsModal", () => ({ ProjectDetailsModal: () => null }));

function lastScope() {
    const calls = usePaginatedProjectsSpy.mock.calls;
    return (calls[calls.length - 1][0] as { scope: string }).scope;
}

describe("ProjectsOverview tabs", () => {
    beforeEach(() => {
        activeTab.current = "all";
        workspace.current = "org-1";
        projectRows.current = [];
        setActiveTab.mockReset();
        retrySpy.mockReset();
        usePaginatedProjectsSpy.mockReset();
        vi.stubGlobal(
            "matchMedia",
            vi.fn().mockReturnValue({
                matches: true,
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
            }),
        );
    });

    it.each([1, 2])("matches toolbar and right-click actions for %i selected projects", async (count) => {
        const user = userEvent.setup();
        projectRows.current = [1, 2].map((index) => ({
            id: `project-${index}`, name: `Project ${index}`, user_id: "user-1",
            access_role: "owner", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
        }));
        render(<ProjectsOverview />);
        await user.click(screen.getByRole("checkbox", { name: "Select Project 1" }));
        if (count === 2) await user.click(screen.getByRole("checkbox", { name: "Select Project 2" }));
        await user.click(screen.getByRole("button", { name: "Actions" }));
        const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
        expect(items).toEqual(count === 1 ? ["Open", "Edit details", "Delete"] : ["Delete 2 projects"]);
        await user.keyboard("{Escape}");
        fireEvent.contextMenu(screen.getByText("Project 1"), { clientX: 40, clientY: 40 });
        expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(items);
    });

    it("shows All first and defaults to it", () => {
        activeTab.current = "unknown";
        render(<ProjectsOverview />);

        const tabs = ["All", "Private", "Public"].map((label) =>
            screen.getByRole("button", { name: label }),
        );
        expect(tabs[0].compareDocumentPosition(tabs[1])).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(tabs[1].compareDocumentPosition(tabs[2])).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(lastScope()).toBe("all");
    });

    it("selects the All tab", async () => {
        const user = userEvent.setup();
        activeTab.current = "private";
        render(<ProjectsOverview />);

        await user.click(screen.getByRole("button", { name: "All" }));

        expect(setActiveTab).toHaveBeenCalledWith("all");
    });

    it("shows All, My Projects, and Shared with Me in the personal workspace", async () => {
        workspace.current = "personal";
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        const tabs = ["All", "My Projects", "Shared with Me"].map((label) =>
            screen.getByRole("button", { name: label }),
        );
        expect(tabs[0].compareDocumentPosition(tabs[1])).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(tabs[1].compareDocumentPosition(tabs[2])).toBe(
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
        expect(tabs[0]).toHaveAttribute("aria-pressed", "true");
        expect(screen.queryByRole("button", { name: "Private" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Public" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Filter by access" })).not.toBeInTheDocument();

        await user.click(tabs[1]);
        expect(setActiveTab).toHaveBeenLastCalledWith("mine");
        await user.click(tabs[2]);
        expect(setActiveTab).toHaveBeenLastCalledWith("shared");
    });

    it.each(["all", "mine", "shared"])("requests the %s scope in the personal workspace", (tab) => {
        workspace.current = "personal";
        activeTab.current = tab;
        render(<ProjectsOverview />);

        expect(lastScope()).toBe(tab);
    });

    it.each([
        ["org-1", "private", "personal"],
        ["org-1", "public", "personal"],
        ["personal", "mine", "org-1"],
        ["personal", "shared", "org-1"],
    ])("falls back to All when switching from %s with %s selected to %s", (from, tab, to) => {
        workspace.current = from;
        activeTab.current = tab;
        const view = render(<ProjectsOverview />);
        expect(lastScope()).not.toBe("all");

        workspace.current = to;
        view.rerender(<ProjectsOverview />);

        expect(lastScope()).toBe("all");
        expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    });

    it("explains when no projects have been shared with the user", () => {
        workspace.current = "personal";
        activeTab.current = "shared";
        render(<ProjectsOverview />);

        expect(screen.getByText("No projects shared with you")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    });

    it("filters Public and Private from the Access column header", async () => {
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        await user.click(
            screen.getByRole("button", { name: "Filter by access" }),
        );
        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent),
        ).toEqual(["All Access", "Public", "Private"]);
        await user.click(screen.getByRole("menuitem", { name: "Public" }));

        expect(setActiveTab).toHaveBeenCalledWith("public");
    });

    it("maps each tab to its backend scope", () => {
        activeTab.current = "public";
        const open = render(<ProjectsOverview />);
        expect(lastScope()).toBe("public");
        open.unmount();

        // Private is everything that is not public, shared with individuals
        // or not — not only the projects nobody else can open.
        activeTab.current = "private";
        render(<ProjectsOverview />);
        expect(lastScope()).toBe("nonpublic");
    });

    it("says there are no public projects, without offering to create one there", () => {
        activeTab.current = "public";
        render(<ProjectsOverview />);
        expect(screen.getByText("No public projects")).toBeInTheDocument();
    });

    it("falls back to All for a tab that no longer exists", () => {
        // An old link or remembered tab may still name "shared".
        activeTab.current = "shared";
        render(<ProjectsOverview />);
        expect(lastScope()).toBe("all");
    });

    it("offers project creation when All is empty", () => {
        render(<ProjectsOverview />);

        expect(
            screen.getByRole("button", { name: "Create" }),
        ).toBeInTheDocument();
        expect(screen.queryByText(/No all projects/i)).not.toBeInTheDocument();
    });

    it("labels each row's access Public, Private or Private (Shared)", () => {
        const baseProject = {
            user_id: "user-1",
            cm_number: null,
            practice: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
        };
        projectRows.current = [
            {
                ...baseProject,
                id: "private-project",
                name: "Private matter",
                access_scope: "private",
            },
            {
                ...baseProject,
                id: "shared-project",
                name: "Shared matter",
                access_scope: "shared",
                direct_grant_count: 2,
            },
            {
                ...baseProject,
                id: "org-project",
                name: "Firm matter",
                access_scope: "organization",
                organization_name: "Elite Law LLP",
            },
        ];

        render(<ProjectsOverview />);

        expect(screen.getByText("Access")).toBeInTheDocument();
        const accessOf = (name: string) =>
            within(
                screen.getByText(name).closest(".group") as HTMLElement,
            );
        expect(
            accessOf("Private matter").getByText("Private"),
        ).toBeInTheDocument();
        expect(
            accessOf("Shared matter").getByText("Private (Shared)"),
        ).toBeInTheDocument();
        expect(accessOf("Firm matter").getByText("Public")).toBeInTheDocument();
        // How many people, and whose "everyone", are in the hover detail.
        expect(screen.getByTitle("Shared with 3 users")).toBeVisible();
        expect(
            screen.getByTitle("Shared with everyone in Elite Law LLP"),
        ).toBeVisible();
    });

    it("shows each project's creator with their avatar", () => {
        projectRows.current = [
            {
                id: "colleague-project",
                user_id: "user-2",
                name: "Colleague matter",
                cm_number: null,
                practice: null,
                access_scope: "organization",
                owner_display_name: "Ada Lovelace",
                owner_email: "ada@example.com",
                owner_profile_photo: "data:image/png;base64,AAAA",
                created_at: "2026-01-01T00:00:00Z",
                updated_at: "2026-01-01T00:00:00Z",
            },
        ];

        render(<ProjectsOverview />);

        expect(screen.getByText("Creator")).toBeInTheDocument();
        expect(screen.queryByText("Created by")).toBeNull();
        const row = within(
            screen.getByText("Colleague matter").closest(".group") as HTMLElement,
        );
        expect(row.getByText("Ada Lovelace")).toBeInTheDocument();
        const avatar = row.getByRole("img", { name: "Ada Lovelace" });
        expect(avatar.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,AAAA");
    });

    it("refetches when the new-project modal closes on a project it never handed over", async () => {
        // A project created behind a failed grant or upload never reaches
        // onCreated, so without this refetch the row the user just made is
        // missing from the list they land back on until a reload.
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        await user.click(screen.getByRole("button", { name: "Create" }));
        await user.click(
            screen.getByRole("button", { name: "close after partial create" }),
        );

        expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    it("does not refetch when the new-project modal is simply cancelled", async () => {
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        await user.click(screen.getByRole("button", { name: "Create" }));
        await user.click(
            screen.getByRole("button", { name: "close untouched" }),
        );

        expect(retrySpy).not.toHaveBeenCalled();
    });
});
