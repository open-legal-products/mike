import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { deleteProject } from "@/app/lib/mikeApi";
import { usePaginatedProjects } from "@/app/hooks/usePaginatedProjects";
import type { Project } from "@/app/components/shared/types";
import { ProjectsOverview } from "./ProjectsOverview";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => "/projects",
}));
vi.mock("@/app/lib/mikeApi", () => ({
    deleteProject: vi.fn(async () => {}),
    setProjectMemoryEnabled: vi.fn(),
    updateProject: vi.fn(),
    getProjectFilterOptions: vi.fn(async () => ({
        practices: [],
        owners: [],
    })),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("./NewProjectModal", () => ({ NewProjectModal: () => null }));
vi.mock("./ProjectDetailsModal", () => ({ ProjectDetailsModal: () => null }));
vi.mock("@/app/hooks/usePaginatedProjects", () => ({
    usePaginatedProjects: vi.fn(),
}));

const DANA = {
    user_id: "u-dana",
    email: "dana@firm.test",
    display_name: "Dana Reyes",
    source: "organization" as const,
};

function project(over: Partial<Project> & { id: string }): Project {
    return {
        user_id: "someone-else",
        name: over.id,
        cm_number: null,
        practice: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...over,
    } as Project;
}

/** Ids the caller selected. Rows the hook could page in are listed too. */
function mockHook(rows: Project[], selected: string[], ownerIds: Record<string, string | null> = {}) {
    const setSelectedIds = vi.fn();
    vi.mocked(usePaginatedProjects).mockReturnValue({
        projects: rows,
        setProjects: vi.fn(),
        loading: false,
        loadingMore: false,
        hasMore: false,
        error: null,
        loadMoreError: null,
        loadMore: vi.fn(),
        retry: vi.fn(),
        selectedProjectIds: selected,
        setSelectedProjectIds: setSelectedIds,
        selectAllMatching: vi.fn(),
        selectingAll: false,
        getProjectOwnerId: (id: string) => ownerIds[id] ?? null,
    } as unknown as ReturnType<typeof usePaginatedProjects>);
    return setSelectedIds;
}

async function bulkDelete() {
    fireEvent.click(screen.getByText("Actions"));
    fireEvent.click(screen.getByText("Delete"));
}

describe("ProjectsOverview bulk delete", () => {
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

    it("skips rows whose creator is unknown instead of deleting them", async () => {
        // The regression: `!creatorId || creatorId === user?.id` read "we
        // could not identify this row's creator" as permission to delete it.
        // Select-all-matching is precisely the path that returns ids whose
        // rows were never paged in, so this was reachable in normal use.
        mockHook(
            [project({ id: "mine", access_role: "owner" })],
            ["mine", "unknown-row"],
            { "unknown-row": null },
        );
        render(<ProjectsOverview />);

        await bulkDelete();

        await waitFor(() => expect(deleteProject).toHaveBeenCalledTimes(1));
        expect(deleteProject).toHaveBeenCalledWith("mine");
        expect(deleteProject).not.toHaveBeenCalledWith("unknown-row");
    });

    it("still deletes an unloaded row the caller demonstrably created", async () => {
        mockHook([], ["off-page"], { "off-page": "me" });
        render(<ProjectsOverview />);

        await bulkDelete();

        await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("off-page"));
    });

    it("names an admin the refused user can ask", async () => {
        // The refusal popup's whole point is the "ask …" line, and the list
        // surfaces used to render it with no contacts at all — so on exactly
        // the screens where a member is most likely to be refused, the
        // refusal was a dead end.
        mockHook(
            [
                project({
                    id: "theirs",
                    access_role: "editor",
                    admin_contacts: [DANA],
                }),
            ],
            ["theirs"],
        );
        render(<ProjectsOverview />);

        await bulkDelete();

        await waitFor(() =>
            expect(
                screen.getByText(/only a project owner can delete a project/),
            ).toBeInTheDocument(),
        );
        expect(
            screen.getByText("Dana Reyes (dana@firm.test)"),
        ).toBeInTheDocument();
        expect(deleteProject).not.toHaveBeenCalled();
    });
});
