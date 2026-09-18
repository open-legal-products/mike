import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectSummaries } from "@/app/lib/mikeApi";
import { AppSidebar } from "./AppSidebar";

const state = vi.hoisted(() => ({
  signOut: vi.fn(),
}));

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
    user: { id: "memory-menu-user", email: "alice@example.com" },
    signOut: state.signOut,
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

describe("AppSidebar account dropdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProjectSummaries).mockResolvedValue([]);
    state.signOut.mockResolvedValue(undefined);
  });

  it("keeps memory navigation inside Settings", async () => {
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await user.click(screen.getByText("Alice").closest("button")!);

    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Memory" })).toBeNull();
  });

  it("shows the IDE navigation directly below Assistant", () => {
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    const assistant = screen.getByRole("button", { name: "Assistant" });
    const ide = screen.getByRole("button", { name: "IDE" });

    expect(assistant.parentElement?.nextElementSibling).toContainElement(ide);
  });

  it("shows a warning popup when sign out fails", async () => {
    state.signOut.mockRejectedValue(new Error("network unavailable"));
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await user.click(screen.getByText("Alice").closest("button")!);
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByText("Sign out failed")).toBeInTheDocument();
    expect(
      screen.getByText("Unable to sign out. Please try again."),
    ).toBeInTheDocument();
  });

  it.each([
    { isOpen: true, toggleName: "Close sidebar" },
    { isOpen: false, toggleName: "Open sidebar" },
  ])(
    "keeps the header row at a fixed height when isOpen is $isOpen",
    ({ isOpen, toggleName }) => {
      render(<AppSidebar isOpen={isOpen} onToggle={vi.fn()} />);

      expect(
        screen.getByRole("button", { name: toggleName }).parentElement,
      ).toHaveClass("h-12", "shrink-0");
    },
  );

  it.each([true, false])(
    "keeps the account button at a fixed height when isOpen is %s",
    (isOpen) => {
      render(<AppSidebar isOpen={isOpen} onToggle={vi.fn()} />);

      expect(screen.getByRole("button", { name: "Account menu" })).toHaveClass(
        "h-12",
        "shrink-0",
      );
    },
  );
});
