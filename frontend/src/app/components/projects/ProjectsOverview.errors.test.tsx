import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteProject, getProjectFilterOptions } from "@/app/lib/mikeApi";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import type { Project } from "@/app/components/shared/types";
import { ProjectsOverview } from "./ProjectsOverview";

const { rows, selection } = vi.hoisted(() => ({
    rows: { current: [] as Project[] },
    selection: { current: [] as string[] },
}));

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
    useAuth: () => ({
        user: { id: "me", email: "me@firm.test" },
        isAuthenticated: true,
        authLoading: false,
    }),
}));

vi.mock("./NewProjectModal", () => ({ NewProjectModal: () => null }));
vi.mock("./ProjectDetailsModal", () => ({ ProjectDetailsModal: () => null }));

// A stateful stand-in for the paging hook: the optimistic delete and its
// revert are the behaviour under test, so `setProjects` has to really move
// the list.
vi.mock("@/app/hooks/usePaginatedProjects", async () => {
    const { useState } = await import("react");
    return {
        usePaginatedProjects: () => {
            const [projects, setProjects] = useState<Project[]>(rows.current);
            const [selectedProjectIds, setSelectedProjectIds] = useState<
                string[]
            >(selection.current);
            return {
                projects,
                setProjects,
                loading: false,
                loadingMore: false,
                hasMore: false,
                error: null,
                loadMoreError: null,
                loadMore: vi.fn(),
                retry: vi.fn(),
                selectedProjectIds,
                setSelectedProjectIds,
                selectAllMatching: vi.fn(),
                selectingAll: false,
                getProjectOwnerId: () => null,
            };
        },
    };
});

function project(id: string, name: string): Project {
    return {
        id,
        name,
        user_id: "me",
        cm_number: null,
        practice: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        access_role: "owner",
        is_owner: true,
    } as Project;
}

function renderOverview() {
    return render(
        <>
            <ProjectsOverview />
            <ToastViewportUI />
        </>,
    );
}

describe("ProjectsOverview failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearToasts();
        rows.current = [];
        selection.current = [];
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

    afterEach(() => {
        clearToasts();
    });

    // The row used to come back with no explanation beyond a console line
    // and a warning popup that named neither the project nor a next step.
    it("restores the row and names the project when a delete fails", async () => {
        const user = userEvent.setup();
        rows.current = [project("p1", "Matter A")];
        vi.mocked(deleteProject).mockRejectedValue(new Error("boom"));

        renderOverview();

        await user.click(screen.getByRole("button", { name: "Open row actions" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(/Couldn't delete/);
        expect(alert).toHaveTextContent(/Matter A/);
        // Reverted: the row the user saw disappear is back.
        expect(screen.getByText("Matter A")).toBeInTheDocument();
        expect(
            within(alert).getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
    });

    it("reports how many rows a bulk delete could not remove", async () => {
        const user = userEvent.setup();
        rows.current = [project("p1", "Matter A"), project("p2", "Matter B")];
        selection.current = ["p1", "p2"];
        vi.mocked(deleteProject).mockImplementation(async (id: string) => {
            if (id === "p2") throw new Error("boom");
        });

        renderOverview();

        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("button", { name: "Delete" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent(
            "1 of 2 projects couldn't be deleted (Matter B)",
        );
        // The failed row is back; the deleted one is gone.
        expect(screen.getByText("Matter B")).toBeInTheDocument();
        expect(screen.queryByText("Matter A")).not.toBeInTheDocument();

        vi.mocked(deleteProject).mockClear();
        await user.click(within(alert).getByRole("button", { name: "Retry" }));

        // Retry re-runs only what failed.
        await waitFor(() =>
            expect(deleteProject).toHaveBeenCalledExactlyOnceWith("p2"),
        );
    });

    it("says when the project filters could not be loaded", async () => {
        vi.mocked(getProjectFilterOptions).mockRejectedValue(
            new Error("boom"),
        );

        renderOverview();

        await waitFor(() =>
            expect(
                screen.getByText("Couldn't load the project filters"),
            ).toBeInTheDocument(),
        );
    });
});
