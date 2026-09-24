import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectSummaries } from "@/app/lib/mikeApi";
import { beginAssistantTurn } from "@/app/lib/assistantTurns";
import { AppSidebar } from "./AppSidebar";

const state = vi.hoisted(() => ({
  signOut: vi.fn(),
  pathname: "/assistant",
  chats: [] as Array<{
    id: string;
    title: string;
    user_id: string;
    created_at: string;
    is_owner: boolean;
  }>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => state.pathname,
}));

vi.mock("next/image", () => ({
  default: ({ className }: { className?: string }) => (
    <span aria-hidden="true" className={className} />
  ),
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
    chats: state.chats,
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
    state.pathname = "/assistant";
    state.chats = [];
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


  it("shows responses loading while selected and detached, then marks a detached response complete until opened", async () => {
    const user = userEvent.setup();
    state.pathname = "/assistant/chat/chat-1";
    state.chats = [
      {
        id: "chat-1",
        title: "Quarterly filing",
        user_id: "memory-menu-user",
        created_at: new Date().toISOString(),
        is_owner: true,
      },
    ];
    const view = render(<AppSidebar isOpen onToggle={vi.fn()} />);
    const turn = beginAssistantTurn("chat-1", {
      userMessage: { role: "user", content: "Summarize" },
      assistant: { role: "assistant", content: "" },
      cancel: vi.fn(),
    });

    expect(
      await screen.findByRole("status", {
        name: "Quarterly filing response loading",
      }),
    ).toBeInTheDocument();

    state.pathname = "/assistant/chat/chat-2";
    view.rerender(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(
      await screen.findByRole("status", {
        name: "Quarterly filing response loading",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Quarterly filing (Response loading)",
      }),
    ).toBeInTheDocument();

    act(() => turn.finish());

    const completedRow = await screen.findByRole("button", {
      name: "Quarterly filing (Response complete)",
    });
    expect(
      completedRow.parentElement?.querySelector("span[aria-hidden='true']"),
    ).toHaveClass("hue-rotate-[285deg]");

    await user.click(completedRow);

    expect(
      screen.getByRole("button", { name: "Quarterly filing" }),
    ).toBeInTheDocument();
    expect(
      completedRow.parentElement?.querySelector("span[aria-hidden='true']"),
    ).not.toHaveClass("hue-rotate-[285deg]");
  });

  it("does not mark a selected response green when it completes", async () => {
    state.pathname = "/assistant/chat/chat-1";
    state.chats = [
      {
        id: "chat-1",
        title: "Quarterly filing",
        user_id: "memory-menu-user",
        created_at: new Date().toISOString(),
        is_owner: true,
      },
    ];
    render(<AppSidebar isOpen onToggle={vi.fn()} />);
    const turn = beginAssistantTurn("chat-1", {
      userMessage: { role: "user", content: "Summarize" },
      assistant: { role: "assistant", content: "" },
      cancel: vi.fn(),
    });

    expect(
      await screen.findByRole("status", {
        name: "Quarterly filing response loading",
      }),
    ).toBeInTheDocument();

    act(() => turn.finish());

    const selectedRow = await screen.findByRole("button", {
      name: "Quarterly filing",
    });
    expect(
      selectedRow.parentElement?.querySelector("span[aria-hidden='true']"),
    ).not.toHaveClass("hue-rotate-[285deg]");
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
