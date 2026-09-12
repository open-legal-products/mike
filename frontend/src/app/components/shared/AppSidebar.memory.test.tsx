import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ptBR from "../../../../messages/pt-BR.json";
import { withIntl } from "@/test/withIntl";
import { listProjectSummaries } from "@/app/lib/mikeApi";
import { AppSidebar } from "./AppSidebar";

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

describe("AppSidebar account dropdown", () => {
  const messages = {
    ...ptBR,
    shell: {
      ...ptBR.shell,
      sidebar: {
        ...ptBR.shell.sidebar,
        ...ptBR.shared.appSidebar,
        sair: ptBR.auth.signOut,
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProjectSummaries).mockResolvedValue([]);
  });

  it("keeps memory navigation inside Settings", async () => {
    const user = userEvent.setup();
    render(withIntl(<AppSidebar isOpen onToggle={vi.fn()} />, messages));

    await user.click(screen.getByText("Alice").closest("button")!);

    expect(
        screen.getByRole("button", { name: "Configurações da Conta" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Memory" })).toBeNull();
  });
});
