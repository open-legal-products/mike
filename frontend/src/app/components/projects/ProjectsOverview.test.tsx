import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsOverview } from "./ProjectsOverview";

const { activeTab, projectRows, setActiveTab, usePaginatedProjectsSpy } =
    vi.hoisted(() => ({
        activeTab: { current: "all" as string },
        projectRows: { current: [] as Record<string, unknown>[] },
        setActiveTab: vi.fn(),
        usePaginatedProjectsSpy: vi.fn(),
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
        return {
            projects: projectRows.current,
            setProjects: vi.fn(),
            loading: false,
            loadingMore: false,
            hasMore: false,
            error: null,
            loadMoreError: null,
            loadMore: vi.fn(),
            retry: vi.fn(),
            selectedProjectIds: [],
            setSelectedProjectIds: vi.fn(),
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

vi.mock("@/app/lib/mikeApi", () => ({
    getProjectFilterOptions: vi.fn(() => new Promise(() => {})),
    setProjectMemoryEnabled: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
}));

vi.mock("./NewProjectModal", () => ({ NewProjectModal: () => null }));
vi.mock("./ProjectDetailsModal", () => ({ ProjectDetailsModal: () => null }));

function lastScope() {
    const calls = usePaginatedProjectsSpy.mock.calls;
    return (calls[calls.length - 1][0] as { scope: string }).scope;
}

describe("ProjectsOverview tabs", () => {
    beforeEach(() => {
        activeTab.current = "all";
        projectRows.current = [];
        setActiveTab.mockReset();
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

    it("shows All first and defaults to it", () => {
        activeTab.current = "unknown";
        render(<ProjectsOverview />);

        const tabs = ["All", "Shared", "Private"].map((label) =>
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

    it("filters Private and Shared from the Access column header", async () => {
        const user = userEvent.setup();
        render(<ProjectsOverview />);

        await user.click(
            screen.getByRole("button", { name: "Filter by access" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Shared" }));

        expect(setActiveTab).toHaveBeenCalledWith("shared");
    });

    it("maps each tab to its backend scope", () => {
        activeTab.current = "shared";
        const shared = render(<ProjectsOverview />);
        expect(lastScope()).toBe("collaborative");
        shared.unmount();

        activeTab.current = "private";
        render(<ProjectsOverview />);
        expect(lastScope()).toBe("private");
    });

    it("offers project creation when All is empty", () => {
        render(<ProjectsOverview />);

        expect(
            screen.getByRole("button", { name: "Create" }),
        ).toBeInTheDocument();
        expect(screen.queryByText(/No all projects/i)).not.toBeInTheDocument();
    });

    it("shows private, shared, and organisation access scopes", () => {
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
        expect(screen.getAllByText("Private")).toHaveLength(2);
        expect(screen.getByText("3 users")).toBeInTheDocument();
        expect(screen.getByText("Elite Law LLP")).toBeInTheDocument();
        expect(screen.getByTitle("Shared with Elite Law LLP")).toBeVisible();
    });
});
