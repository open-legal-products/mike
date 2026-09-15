import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjects } from "@/app/lib/mikeApi";
import IdePage from "./page";

const state = vi.hoisted(() => ({
    push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: state.push }),
}));

vi.mock("next/image", () => ({
    default: ({ alt = "", ...props }: React.ComponentProps<"img">) => (
        // eslint-disable-next-line @next/next/no-img-element -- simple test stand-in for next/image
        <img alt={alt} {...props} />
    ),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/mikeApi")>();
    return { ...actual, listProjects: vi.fn() };
});

vi.mock("@/app/components/modals/ProjectPickerModal", () => ({
    ProjectPickerModal: ({
        open,
        projects,
        onSelect,
        primaryAction,
    }: {
        open: boolean;
        projects: Array<{ id: string; name: string }>;
        onSelect: (id: string) => void;
        primaryAction?: {
            label: ReactNode;
            onClick?: () => void;
            disabled?: boolean;
        };
    }) =>
        open ? (
            <div role="dialog" aria-label="Open project">
                {projects.map((project) => (
                    <button
                        key={project.id}
                        type="button"
                        onClick={() => onSelect(project.id)}
                    >
                        {project.name}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={primaryAction?.onClick}
                    disabled={primaryAction?.disabled}
                >
                    {primaryAction?.label}
                </button>
            </div>
        ) : null,
}));

vi.mock("@/app/components/projects/NewProjectModal", () => ({
    NewProjectModal: ({
        open,
        onCreated,
    }: {
        open: boolean;
        onCreated: (project: { id: string }) => void;
    }) =>
        open ? (
            <button
                type="button"
                onClick={() => onCreated({ id: "project-new" })}
            >
                Complete project creation
            </button>
        ) : null,
}));

describe("IDE page", () => {
    beforeEach(() => {
        state.push.mockReset();
        vi.mocked(listProjects).mockReset();
        vi.mocked(listProjects).mockResolvedValue([
            {
                id: "project-1",
                user_id: "user-1",
                name: "Matter Alpha",
                cm_number: null,
                practice: null,
                memory_enabled: false,
                created_at: "2026-09-14T00:00:00.000Z",
                updated_at: "2026-09-14T00:00:00.000Z",
            },
        ]);
    });

    it("opens a selected project's chats", async () => {
        const user = userEvent.setup();
        render(<IdePage />);

        expect(
            screen.getByText("Integrated Drafting Environment"),
        ).toBeVisible();
        expect(screen.queryByRole("heading", { name: "IDE" })).toBeNull();
        const placeholder = screen
            .getByText("Integrated Drafting Environment")
            .closest('[data-slot="empty-state"]');
        expect(placeholder).toHaveClass("items-start", "text-left");
        expect(placeholder?.parentElement).toHaveClass("liquid-glass-flat");
        expect(screen.getByRole("button", { name: "Open project" })).toHaveClass(
            "h-7",
        );
        expect(screen.getByRole("button", { name: "New project" })).toHaveClass(
            "h-7",
        );
        await user.click(screen.getByRole("button", { name: "Open project" }));
        await user.click(await screen.findByRole("button", { name: "Matter Alpha" }));
        await user.click(
            screen.getByRole("dialog", { name: "Open project" }).querySelector(
                "button:last-child",
            )!,
        );

        expect(listProjects).toHaveBeenCalledOnce();
        expect(state.push).toHaveBeenCalledWith(
            "/projects/project-1/assistant/chat",
        );
    });

    it("opens the new project's chats after creation", async () => {
        const user = userEvent.setup();
        render(<IdePage />);

        await user.click(screen.getByRole("button", { name: "New project" }));
        await user.click(
            screen.getByRole("button", { name: "Complete project creation" }),
        );

        await waitFor(() =>
            expect(state.push).toHaveBeenCalledWith(
                "/projects/project-new/assistant/chat",
            ),
        );
    });
});
