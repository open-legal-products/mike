import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    deleteWorkflow,
    getWorkflow,
    updateWorkflow,
} from "@/app/lib/mikeApi";
import type { Workflow } from "@/app/components/shared/types";
import { WorkflowDetailPage } from "./WorkflowDetailPage";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSearchParams: () => new URLSearchParams(),
    usePathname: () => "/workflows/wf-1",
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
    deleteWorkflow: vi.fn(),
    listWorkflowShares: vi.fn(async () => []),
    getWorkflowPeople: vi.fn(async () => ({ owner: null, members: [] })),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "user-1", email: "user@example.com" } }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { displayName: "User", practiceAreas: [] },
    }),
}));

// The real editor is Tiptap behind a dynamic import; this stub is the same
// contract (a controlled value with an onChange).
vi.mock("@/app/components/ui/markdown-editor", () => ({
    MarkdownEditor: ({
        value,
        onChange,
    }: {
        value: string;
        onChange?: (value: string) => void;
    }) => (
        <textarea
            aria-label="Workflow prompt"
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
        />
    ),
}));

vi.mock("./WorkflowAssets", () => ({
    WorkflowAssets: () => null,
}));

vi.mock("@/app/components/workflows/UseWorkflowModal", () => ({
    UseWorkflowModal: () => null,
}));

vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));

vi.mock("@/app/components/modals/AccessModal", () => ({
    AccessModal: () => null,
}));

vi.mock("@/app/components/workflows/NewWorkflowModal", () => ({
    NewWorkflowModal: () => null,
}));

vi.mock("@/app/components/workflows/OpenSourceWorkflowModal", () => ({
    OpenSourceWorkflowModal: () => null,
}));

function tabularWorkflow(): Workflow {
    return {
        ...assistantWorkflow(),
        metadata: { ...assistantWorkflow().metadata, type: "tabular" as const },
        skill_md: null,
        columns_config: [
            { index: 0, name: "Party", prompt: "Who?", format: "text" },
            { index: 1, name: "Date", prompt: "When?", format: "text" },
        ],
    } as unknown as Workflow;
}

/** Delete one column through its own row actions. */
async function deleteColumn(
    user: ReturnType<typeof userEvent.setup>,
    name: string,
) {
    // The smallest ancestor of the column's name holding one row-actions
    // button is that column's row.
    let row: HTMLElement | null = await screen.findByText(name);
    while (
        row &&
        within(row).queryAllByRole("button", { name: "Open row actions" })
            .length !== 1
    ) {
        row = row.parentElement;
    }
    const button = within(row!).getByRole("button", {
        name: "Open row actions",
    });
    await user.click(button);
    await user.click(await screen.findByRole("menuitem", { name: /^Delete/ }));
}

function assistantWorkflow(): Workflow {
    return {
        id: "wf-1",
        user_id: "user-1",
        metadata: {
            title: "Deposition prep",
            description: null,
            type: "assistant",
            contributors: [],
            language: "en",
            version: "1",
            practice: null,
            jurisdictions: null,
        },
        skill_md: "Ask the witness",
        columns_config: null,
        is_system: false,
        is_owner: true,
        created_at: "2026-09-01T00:00:00Z",
    } as unknown as Workflow;
}

describe("WorkflowDetailPage failures", () => {
    beforeEach(() => {
        clearToasts();
        vi.clearAllMocks();
        vi.mocked(updateWorkflow).mockReset().mockResolvedValue(assistantWorkflow());
        vi.mocked(deleteWorkflow).mockReset().mockResolvedValue(undefined);
        vi.mocked(getWorkflow).mockResolvedValue(assistantWorkflow());
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
        vi.useRealTimers();
    });

    it("says an autosave failed and retries with the draft as it stands now", async () => {
        // The autosave used to drop back to "idle" and lose the writing
        // without ever saying so.
        vi.mocked(updateWorkflow).mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        render(
            <>
                <WorkflowDetailPage id="wf-1" workflowType="assistant" />
                <ToastViewportUI />
            </>,
        );

        const editor = await screen.findByLabelText("Workflow prompt");
        await user.clear(editor);
        await user.type(editor, "First draft");
        // The save is debounced by 800ms.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 900));
        });

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't save your changes");
        expect(await screen.findByText("Couldn't save")).toBeVisible();

        // The user keeps typing; Retry must save what is in the editor now.
        vi.mocked(updateWorkflow).mockResolvedValue(assistantWorkflow());
        await user.type(editor, " and more");
        await user.click(within(alert).getByRole("button", { name: "Retry" }));

        await waitFor(() =>
            expect(updateWorkflow).toHaveBeenLastCalledWith("wf-1", {
                skill_md: "First draft and more",
            }),
        );
    });

    it("puts deleted columns back and says the column save failed", async () => {
        const tabular = {
            ...assistantWorkflow(),
            metadata: {
                ...assistantWorkflow().metadata,
                type: "tabular" as const,
            },
            skill_md: null,
            columns_config: [
                { index: 0, name: "Party", prompt: "Who?", format: "text" },
                { index: 1, name: "Date", prompt: "When?", format: "text" },
            ],
        } as unknown as Workflow;
        vi.mocked(getWorkflow).mockResolvedValue(tabular);
        vi.mocked(updateWorkflow).mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        render(
            <>
                <WorkflowDetailPage id="wf-1" workflowType="tabular" />
                <ToastViewportUI />
            </>,
        );

        expect(await screen.findByText("Party")).toBeVisible();
        // Select every column, then delete the selection.
        await user.click(screen.getAllByRole("checkbox")[0]);
        await user.click(screen.getByRole("button", { name: "Actions" }));
        await user.click(screen.getByRole("menuitem", { name: /^Delete/ }));

        // Under load the prompt autosave debounce can fire during this test
        // and raise its own toast for the same rejected mock, so pick the
        // column-save toast by content rather than assuming a single alert.
        await screen.findAllByRole("alert");
        await waitFor(() =>
            expect(
                screen
                    .getAllByRole("alert")
                    .some((el) =>
                        el.textContent?.includes("Couldn't save the columns"),
                    ),
            ).toBe(true),
        );
        // The optimistic removal is undone before the toast: the table never
        // shows a layout the server refused.
        expect(await screen.findByText("Party")).toBeVisible();
        expect(screen.getByText("Date")).toBeVisible();
    });

    it("says a workflow delete failed and retries only through the confirmation", async () => {
        vi.mocked(deleteWorkflow).mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        render(
            <>
                <WorkflowDetailPage id="wf-1" workflowType="assistant" />
                <ToastViewportUI />
            </>,
        );

        await screen.findByLabelText("Workflow prompt");
        await user.click(
            screen.getByRole("button", { name: "Workflow actions" }),
        );
        await user.click(
            await screen.findByRole("menuitem", { name: "Delete" }),
        );
        await user.click(
            await screen.findByRole("button", { name: "Delete" }),
        );

        const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
        expect(alert).toHaveTextContent("Couldn't delete this workflow");

        // Retry never deletes from the notice; the confirmation does.
        vi.mocked(deleteWorkflow).mockClear();
        await user.click(within(alert).getByRole("button", { name: "Retry" }));
        expect(deleteWorkflow).not.toHaveBeenCalled();
        expect(
            await screen.findByRole("button", { name: "Delete" }),
        ).toBeVisible();
    });

    it("says the workflow could not be loaded instead of claiming it is missing", async () => {
        vi.mocked(getWorkflow).mockRejectedValue(
            Object.assign(new Error("Internal error"), { status: 500 }),
        );
        render(
            <>
                <WorkflowDetailPage id="wf-1" workflowType="assistant" />
                <ToastViewportUI />
            </>,
        );

        // The screen says so with its own "Try again": a transport failure
        // must not be reported as "Workflow not found.", and a notice with a
        // second Retry would repeat the same failure.
        expect(
            await screen.findByRole("button", { name: "Try again" }),
        ).toBeVisible();
        expect(screen.getByText("Couldn't load this workflow")).toBeVisible();
        expect(screen.queryByText("Workflow not found.")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();

        vi.mocked(getWorkflow).mockClear();
        await userEvent.setup().click(
            screen.getByRole("button", { name: "Try again" }),
        );
        await waitFor(() => expect(getWorkflow).toHaveBeenCalledTimes(1));
    });
    it("shows a missing workflow once, without a load-failure notice", async () => {
        vi.mocked(getWorkflow).mockRejectedValue(
            Object.assign(new Error("Not found"), { status: 404 }),
        );
        render(
            <>
                <WorkflowDetailPage id="wf-1" workflowType="assistant" />
                <ToastViewportUI />
            </>,
        );

        expect(await screen.findByText("Workflow not found.")).toBeVisible();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows the loading screen, not \"not found\", while a load retry runs", async () => {
        vi.mocked(getWorkflow).mockRejectedValueOnce(
            Object.assign(new Error("Internal error"), { status: 500 }),
        );
        render(<WorkflowDetailPage id="wf-1" workflowType="assistant" />);
        const tryAgain = await screen.findByRole("button", { name: "Try again" });

        vi.mocked(getWorkflow).mockReturnValue(new Promise(() => {}));
        await userEvent.setup().click(tryAgain);

        await waitFor(() => expect(getWorkflow).toHaveBeenCalledTimes(2));
        expect(screen.queryByText("Workflow not found.")).toBeNull();
    });

    it("keeps \"Couldn't save\" up after an earlier save's \"Saved\" would have faded", async () => {
        vi.mocked(getWorkflow).mockResolvedValue(tabularWorkflow());
        // Keyed on the request, not call order: a debounced save left over
        // from an earlier test must not use up a one-shot answer.
        vi.mocked(updateWorkflow).mockImplementation(async (_id, patch) => {
            if (patch.columns_config?.length === 0) throw new Error("boom");
            return tabularWorkflow();
        });
        const user = userEvent.setup();
        render(<WorkflowDetailPage id="wf-1" workflowType="tabular" />);

        await deleteColumn(user, "Party");
        expect(
            await screen.findByText("Saved", {}, { timeout: 1500 }),
        ).toBeVisible();
        await deleteColumn(user, "Date");
        expect(await screen.findByText("Couldn't save")).toBeVisible();

        // Past the first save's 2s fade.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 2200));
        });
        expect(screen.getByText("Couldn't save")).toBeVisible();
    });

    it("does not let an older failed column save undo a newer one that succeeded", async () => {
        vi.mocked(getWorkflow).mockResolvedValue(tabularWorkflow());
        let failFirst!: (error: unknown) => void;
        vi.mocked(updateWorkflow)
            .mockImplementationOnce(
                () =>
                    new Promise((_, reject) => {
                        failFirst = reject;
                    }),
            )
            .mockResolvedValueOnce(tabularWorkflow());
        const user = userEvent.setup();
        render(
            <>
                <WorkflowDetailPage id="wf-1" workflowType="tabular" />
                <ToastViewportUI />
            </>,
        );

        await deleteColumn(user, "Party");
        await deleteColumn(user, "Date");
        await waitFor(() => expect(updateWorkflow).toHaveBeenCalledTimes(2));
        expect(await screen.findByText("Saved")).toBeVisible();

        await act(async () => {
            failFirst(new Error("boom"));
            await Promise.resolve();
        });

        // The server has the newer (empty) list; the table must too.
        expect(screen.queryByText("Party")).toBeNull();
        expect(screen.queryByText("Date")).toBeNull();
    });

    it("shows the columns a Retry saved", async () => {
        vi.mocked(getWorkflow).mockResolvedValue(tabularWorkflow());
        vi.mocked(updateWorkflow).mockRejectedValueOnce(new Error("boom"));
        const user = userEvent.setup();
        render(
            <>
                <WorkflowDetailPage id="wf-1" workflowType="tabular" />
                <ToastViewportUI />
            </>,
        );

        await deleteColumn(user, "Party");
        const alert = await screen.findByRole("alert");
        expect(await screen.findByText("Party")).toBeVisible();

        vi.mocked(updateWorkflow).mockResolvedValue(tabularWorkflow());
        await user.click(within(alert).getByRole("button", { name: "Retry" }));

        await waitFor(() => expect(screen.queryByText("Party")).toBeNull());
        expect(screen.getByText("Date")).toBeVisible();
    });
});
