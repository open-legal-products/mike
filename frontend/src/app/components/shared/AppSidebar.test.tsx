import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectSummaries } from "@/app/lib/mikeApi";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { AppSidebar } from "./AppSidebar";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    usePathname: () => "/assistant",
}));

vi.mock("next/image", () => ({
    default: () => <span aria-hidden="true" />,
}));

vi.mock("@/app/lib/mikeApi", () => ({
    listProjectSummaries: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "sidebar-user", email: "alice@example.com" },
        signOut,
    }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { displayName: "Alice", tier: "Free" },
    }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        chats: [],
        loadingMoreChats: false,
        loadMoreChats: vi.fn(),
        setCurrentChatId: vi.fn(),
    }),
}));

vi.mock("@/app/components/chat/mike-icon", () => ({
    MikeIcon: () => <span aria-hidden="true" />,
}));

function renderSidebar() {
    return render(
        <>
            <AppSidebar isOpen onToggle={vi.fn()} />
            <ToastViewportUI />
        </>,
    );
}

describe("AppSidebar failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearToasts();
        vi.mocked(listProjectSummaries).mockResolvedValue([]);
        signOut.mockResolvedValue(undefined);
    });

    afterEach(() => {
        clearToasts();
    });

    // The old catch emptied the section, so a failed request looked exactly
    // like an account with no projects.
    it("tells the user when recent projects cannot be loaded", async () => {
        vi.mocked(listProjectSummaries).mockRejectedValue(new Error("boom"));

        renderSidebar();

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Couldn't load your recent projects",
            ),
        );
    });

    it("retries the recent projects load from the toast", async () => {
        const user = userEvent.setup();
        vi.mocked(listProjectSummaries).mockRejectedValueOnce(
            new Error("boom"),
        );

        renderSidebar();

        await waitFor(() => screen.getByRole("alert"));
        await user.click(screen.getByRole("button", { name: "Retry" }));

        await waitFor(() =>
            expect(listProjectSummaries).toHaveBeenCalledTimes(2),
        );
    });

    // Replaces a window.alert(), which is unstyled, blocking, and invisible
    // to the rest of the app.
    it("reports a failed sign-out in a toast instead of window.alert", async () => {
        const user = userEvent.setup();
        const alertSpy = vi
            .spyOn(window, "alert")
            .mockImplementation(() => {});
        signOut.mockRejectedValue(new Error("boom"));

        renderSidebar();

        await user.click(screen.getByText("Alice").closest("button")!);
        await user.click(screen.getByRole("button", { name: "Sign out" }));

        await waitFor(() =>
            expect(screen.getByRole("alert")).toHaveTextContent(
                "Couldn't sign out",
            ),
        );
        expect(alertSpy).not.toHaveBeenCalled();
        expect(
            screen.getByRole("button", { name: "Retry" }),
        ).toBeInTheDocument();
        alertSpy.mockRestore();
    });
});
