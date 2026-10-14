import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectsPage } from "@/app/lib/mikeApi";
import { AppSidebar } from "./AppSidebar";

type Org = { id: string; name: string; role: "owner" | "admin" | "member" };

const ACME: Org = { id: "org-acme", name: "Acme LLP", role: "member" };
const BETA: Org = { id: "org-beta", name: "Beta Chambers", role: "owner" };

const state = vi.hoisted(() => ({
  workspaceId: "personal" as string | null,
  organizations: [] as Org[] | null,
  setWorkspace: vi.fn(),
  push: vi.fn(),
  pathname: "/assistant",
  showToast: vi.fn(),
}));

vi.mock("@/shared/lib/toastStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/toastStore")>()),
  showToast: state.showToast,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: state.push }),
  usePathname: () => state.pathname,
}));

vi.mock("next/image", () => ({
  default: ({ className }: { className?: string }) => (
    <span aria-hidden="true" className={className} />
  ),
}));

vi.mock("@/app/lib/mikeApi", () => ({
  listProjectsPage: vi.fn(),
  listProjectChats: vi.fn(async () => []),
  listTabularReviews: vi.fn(async () => []),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "workspace-user", email: "alice@example.com" },
    signOut: vi.fn(),
  }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: { displayName: "Alice", tier: "Free" } }),
}));

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    chats: [],
    loadingMoreChats: false,
    loadMoreChats: vi.fn(),
    setCurrentChatId: vi.fn(),
  }),
}));

vi.mock("@/app/contexts/WorkspaceContext", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/app/contexts/WorkspaceContext")
  >()),
  useWorkspace: () => ({
    workspaceId: state.workspaceId,
    organizations: state.organizations,
    activeOrganization:
      state.organizations?.find((org) => org.id === state.workspaceId) ?? null,
    setWorkspace: state.setWorkspace,
    refreshOrganizations: vi.fn(),
  }),
}));

vi.mock("@/shared/ui/MikeIconUI", () => ({
  MikeIcon: () => <span aria-hidden="true" />,
}));

const project = (id: string, name: string) => ({
  id,
  user_id: "workspace-user",
  name,
  cm_number: null,
  practice: null,
  memory_enabled: false,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
});

const heading = () =>
  document.querySelector('[data-slot="sidebar-heading"]') as HTMLElement;

const openAccountMenu = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Account menu" }));

beforeEach(() => {
  vi.clearAllMocks();
  state.workspaceId = "personal";
  state.organizations = [];
  state.pathname = "/assistant";
  vi.mocked(listProjectsPage).mockResolvedValue([]);
});

describe("AppSidebar workspace switcher", () => {
  it("offers nothing to switch between for somebody in no organization", async () => {
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(heading()).toHaveTextContent("Mike");
    await openAccountMenu(user);
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument();
  });

  it("heads the sidebar with the organization's name in its workspace", () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = ACME.id;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(heading()).toHaveTextContent("Acme LLP");
    expect(heading()).not.toHaveTextContent("Mike");
    // Still the way home, whatever it is called.
    expect(screen.getByRole("link", { name: "Acme LLP" })).toHaveAttribute(
      "href",
      "/assistant",
    );
  });

  it("heads the sidebar with plain Mike for personal work, even with organizations to switch to", () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = "personal";
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(heading()).toHaveTextContent("Mike");
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
  });

  it("shows a placeholder, not Mike, while a remembered organization's name loads", () => {
    // "Mike" means personal work. Saying it for the moment before the
    // organization's name arrives would name the wrong workspace.
    state.organizations = null;
    state.workspaceId = ACME.id;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(
      screen.getByRole("status", { name: "Loading workspace" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Mike")).not.toBeInTheDocument();
  });

  it("sets an organization's name at the size Mike is, in the same fixed header row", () => {
    state.organizations = [ACME];
    state.workspaceId = ACME.id;
    const { unmount } = render(<AppSidebar isOpen onToggle={vi.fn()} />);
    const organizationClasses = heading().className;
    expect(heading()).toHaveClass("text-xl");
    expect(
      screen.getByRole("button", { name: "Close sidebar" }).parentElement,
    ).toHaveClass("h-11");
    unmount();

    // Switching workspace must not change how the header looks.
    state.workspaceId = "personal";
    render(<AppSidebar isOpen onToggle={vi.fn()} />);
    expect(heading().className).toBe(organizationClasses);
  });

  it("names nothing beside the account button", () => {
    state.organizations = [ACME];
    state.workspaceId = ACME.id;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(screen.queryByText(/Workspace:/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Account menu" }),
    ).not.toHaveTextContent("Acme LLP");
  });

  it("lists the workspaces in the account menu and marks the active one", async () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = ACME.id;
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual([
      "Personal",
      "Acme LLP",
      "Beta Chambers",
    ]);
    // The active one is marked by state, not by colour alone.
    expect(
      screen.getByRole("menuitemradio", { name: "Acme LLP" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("menuitemradio", { name: "Personal" }),
    ).toHaveAttribute("aria-checked", "false");
    // The rest of the account menu is still there.
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  });

  it("sets the Workspace heading over the option text, bold and in normal case", async () => {
    state.organizations = [ACME];
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    const label = screen.getByText("Workspace");
    const option = screen.getByRole("menuitemradio", { name: "Personal" });
    const horizontalPadding = (element: HTMLElement) =>
      [...element.classList].filter((name) => /^px-/.test(name));
    expect(horizontalPadding(label)).toEqual(horizontalPadding(option));
    expect(label).toHaveClass("normal-case", "tracking-normal");
    // The size and weight the sidebar's own section headings use, in
    // place of the 10px the shared label sets for capitals.
    expect(label).toHaveClass("text-xs", "font-semibold");
    expect(label).not.toHaveClass("text-[10px]");
    // `hidden`: the open menu takes the rest of the page out of the
    // accessibility tree.
    expect(
      screen.getByRole("button", { name: "Recent Projects", hidden: true }),
    ).toHaveClass("text-xs", "font-semibold");
    expect(label).not.toHaveClass("uppercase");
    expect(label).not.toHaveClass("tracking-wider");
  });

  it("opens the active organization's settings from the account menu", async () => {
    const user = userEvent.setup();
    state.organizations = [ACME, BETA];
    state.workspaceId = BETA.id;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    await user.click(
      screen.getByRole("menuitem", { name: "Organization" }),
    );

    expect(state.push).toHaveBeenCalledWith(
      "/organizations/org-beta/settings",
    );
  });

  it("offers the settings to a plain member too: they hold General and Members", async () => {
    const user = userEvent.setup();
    state.organizations = [ACME, BETA];
    state.workspaceId = ACME.id;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    expect(
      screen.getByRole("menuitem", { name: "Organization" }),
    ).toBeVisible();
  });

  it("offers no organization settings in the personal workspace, and no separate organizations page", async () => {
    // The organizations a person belongs to are under Settings.
    const user = userEvent.setup();
    state.organizations = [ACME, BETA];
    state.workspaceId = "personal";
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Organization" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Organizations" }),
    ).not.toBeInTheDocument();
  });

  it("switches workspace at once when chosen from the home page", async () => {
    state.organizations = [ACME, BETA];
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    await user.click(
      screen.getByRole("menuitemradio", { name: "Beta Chambers" }),
    );
    expect(state.setWorkspace).toHaveBeenCalledExactlyOnceWith(BETA.id);
    expect(state.push).not.toHaveBeenCalled();
    // Said in a notice that goes sooner than an ordinary one.
    expect(state.showToast).toHaveBeenCalledExactlyOnceWith({
      tone: "info",
      title: "Switched to Beta Chambers",
      message: undefined,
      durationMs: 2500,
      dedupeKey: "workspace-switch",
    });
  });

  it("says so when the switch is to Personal", async () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = BETA.id;
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    await user.click(screen.getByRole("menuitemradio", { name: "Personal" }));
    expect(state.showToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Switched to Personal" }),
    );
  });

  it("leaves for the home page first, and switches once the page has gone", async () => {
    state.organizations = [ACME, BETA];
    state.pathname = "/projects";
    const user = userEvent.setup();
    const view = render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    await user.click(
      screen.getByRole("menuitemradio", { name: "Beta Chambers" }),
    );
    // The switcher is navigation. The list being left is not reloaded for
    // the new workspace first: the workspace has not changed yet.
    expect(state.push).toHaveBeenCalledExactlyOnceWith("/assistant");
    expect(state.setWorkspace).not.toHaveBeenCalled();
    expect(state.showToast).not.toHaveBeenCalled();

    state.pathname = "/assistant";
    view.rerender(<AppSidebar isOpen onToggle={vi.fn()} />);
    expect(state.setWorkspace).toHaveBeenCalledExactlyOnceWith(BETA.id);
    // The notice comes with the switch, not before it.
    expect(state.showToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Switched to Beta Chambers" }),
    );

    // Once only: moving on from home does not switch again.
    state.pathname = "/projects";
    view.rerender(<AppSidebar isOpen onToggle={vi.fn()} />);
    expect(state.setWorkspace).toHaveBeenCalledTimes(1);
  });

  it("still switches if they went somewhere else before home arrived", async () => {
    state.organizations = [ACME, BETA];
    state.pathname = "/projects";
    const user = userEvent.setup();
    const view = render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    await user.click(
      screen.getByRole("menuitemradio", { name: "Beta Chambers" }),
    );
    state.pathname = "/workflows";
    view.rerender(<AppSidebar isOpen onToggle={vi.fn()} />);
    expect(state.setWorkspace).toHaveBeenCalledExactlyOnceWith(BETA.id);
  });

  it("stays put when the workspace already active is chosen again", async () => {
    state.organizations = [ACME, BETA];
    state.workspaceId = BETA.id;
    const user = userEvent.setup();
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await openAccountMenu(user);
    await user.click(
      screen.getByRole("menuitemradio", { name: "Beta Chambers" }),
    );
    expect(state.setWorkspace).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
    expect(state.showToast).not.toHaveBeenCalled();
  });

  it("keeps the switcher reachable from the collapsed sidebar", async () => {
    state.organizations = [ACME];
    const user = userEvent.setup();
    render(<AppSidebar isOpen={false} onToggle={vi.fn()} />);

    // The collapsed sidebar has no heading to name the workspace in.
    expect(document.querySelector('[data-slot="sidebar-heading"]')).toBeNull();
    await openAccountMenu(user);
    expect(
      screen.getByRole("menuitemradio", { name: "Acme LLP" }),
    ).toBeVisible();
  });

  it("loads the active workspace's recent projects, and reloads them on a switch", async () => {
    state.organizations = [ACME];
    vi.mocked(listProjectsPage).mockImplementation(async (options) =>
      options?.workspace === ACME.id
        ? [project("p-org", "Firm matter")]
        : [project("p-mine", "My own matter")],
    );
    const { rerender } = render(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(await screen.findByText("My own matter")).toBeInTheDocument();
    expect(listProjectsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace: "personal", scope: "mine" }),
    );

    state.workspaceId = ACME.id;
    rerender(<AppSidebar isOpen onToggle={vi.fn()} />);

    expect(await screen.findByText("Firm matter")).toBeInTheDocument();
    expect(screen.queryByText("My own matter")).not.toBeInTheDocument();
    expect(listProjectsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspace: ACME.id, scope: "mine" }),
    );

    // Back again: Personal is painted from its own remembered list, never
    // from the organization's.
    state.workspaceId = "personal";
    rerender(<AppSidebar isOpen onToggle={vi.fn()} />);
    await waitFor(() =>
      expect(screen.queryByText("Firm matter")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("My own matter")).toBeInTheDocument();
  });

  it.each(["personal", ACME.id])("paginates only projects the user created in %s", async (workspaceId) => {
    state.workspaceId = workspaceId;
    state.organizations = [ACME];
    const ownProjects = Array.from({ length: 12 }, (_, index) =>
      project(`created-${index}`, `Created matter ${index + 1}`),
    );
    const sharedProject = {
      ...project("shared-owner", "Someone else's matter"),
      user_id: "other-user",
      access_role: "owner" as const,
    };
    vi.mocked(listProjectsPage).mockImplementation(async (options) => {
      const rows = options?.scope === "mine"
        ? ownProjects
        : [sharedProject, ...ownProjects];
      const offset = options?.offset ?? 0;
      return rows.slice(offset, offset + (options?.limit ?? rows.length));
    });
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    const first = await screen.findByText("Created matter 1");
    expect(screen.getByText("Created matter 10")).toBeInTheDocument();
    expect(screen.queryByText("Created matter 11")).not.toBeInTheDocument();
    expect(screen.queryByText("Someone else's matter")).not.toBeInTheDocument();
    expect(listProjectsPage).toHaveBeenLastCalledWith(expect.objectContaining({
      workspace: workspaceId,
      scope: "mine",
      sortKey: "updated",
      sortDirection: "desc",
      limit: 11,
    }));

    const scrollArea = first.closest(".overflow-y-auto") as HTMLElement;
    fireEvent.scroll(scrollArea);

    expect(await screen.findByText("Created matter 12")).toBeInTheDocument();
    expect(listProjectsPage).toHaveBeenLastCalledWith({
      workspace: workspaceId,
      scope: "mine",
      sortKey: "updated",
      sortDirection: "desc",
      limit: 11,
      offset: 10,
    });
    expect(screen.queryByText("Someone else's matter")).not.toBeInTheDocument();

    const callCount = vi.mocked(listProjectsPage).mock.calls.length;
    fireEvent.scroll(scrollArea);
    expect(listProjectsPage).toHaveBeenCalledTimes(callCount);
  });

  it("lines the empty projects placeholder up with the Recent Projects button", async () => {
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    const placeholder = await screen.findByText("No projects yet");
    const button = screen.getByRole("button", { name: "Recent Projects" });
    const horizontalPadding = (element: HTMLElement) =>
      [...element.classList].filter((name) => /^px-/.test(name));
    expect(horizontalPadding(placeholder)).toEqual(horizontalPadding(button));
    expect(horizontalPadding(placeholder)).toEqual(["px-3.5"]);
  });

  it("does not narrow the recent projects outside a workspace provider", async () => {
    state.workspaceId = null;
    state.organizations = null;
    render(<AppSidebar isOpen onToggle={vi.fn()} />);

    await waitFor(() => expect(listProjectsPage).toHaveBeenCalled());
    expect(
      vi.mocked(listProjectsPage).mock.calls[0][0]?.workspace,
    ).toBeUndefined();
    expect(heading()).toHaveTextContent("Mike");
  });
});
