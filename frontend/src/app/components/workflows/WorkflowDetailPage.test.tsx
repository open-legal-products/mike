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
vi.mock("@/app/components/workflows/WorkflowPromptEditor", () => ({
    WorkflowPromptEditor: ({
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
        await user.click(screen.getAllByRole("button", { name: "Delete" })[0]);

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

    it("says a workflow delete failed and offers a Retry", async () => {
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
        expect(
            within(alert).getByRole("button", { name: "Retry" }),
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

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't load this workflow");
        // The screen itself says so too, with a "Try again": a transport
        // failure must not be reported as "Workflow not found."
        expect(
            await screen.findByRole("button", { name: "Try again" }),
        ).toBeVisible();
        expect(screen.queryByText("Workflow not found.")).toBeNull();
    });
});
