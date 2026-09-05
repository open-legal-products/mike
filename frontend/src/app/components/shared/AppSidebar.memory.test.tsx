import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectSummaries } from "@/app/lib/mikeApi";
import { AppSidebar } from "./AppSidebar";

const push = vi.fn();
let pathname = "/assistant";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
    usePathname: () => pathname,
}));

vi.mock("next/image", () => ({
    default: () => <span aria-hidden="true" />,
}));

vi.mock("@/app/lib/mikeApi", () => ({
    listProjectSummaries: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "memory-menu-user", email: "alice@example.com" },
        signOut: vi.fn(),
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

describe("AppSidebar memory navigation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pathname = "/assistant";
        vi.mocked(listProjectSummaries).mockResolvedValue([]);
    });

    it("opens app-wide memory from the account dropdown and closes the menu", async () => {
        const user = userEvent.setup();
        render(<AppSidebar isOpen onToggle={vi.fn()} />);

        const disclosure = screen.getByText("Alice").closest("button")!;
        expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await user.click(disclosure);
        expect(disclosure).toHaveAttribute("aria-expanded", "true");
        const memory = screen.getByRole("button", { name: "Memory" });
        expect(memory).toHaveAttribute("type", "button");
        expect(memory).toHaveClass("focus-visible:ring-2");

        await user.click(memory);

        expect(push).toHaveBeenCalledWith("/settings/memory");
        expect(
            screen.queryByRole("button", { name: "Memory" }),
        ).not.toBeInTheDocument();
    });
});
