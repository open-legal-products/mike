import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError } from "@/app/lib/mikeApi";
import { OrganizationMembers } from "./OrganizationMembers";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refreshOrganizations: vi.fn(async () => {}),
  role: "owner" as "owner" | "admin" | "member",
  getOrg: vi.fn(),
  listOrgMembers: vi.fn(),
  listOrgInvitations: vi.fn(),
  updateOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  getOrgMemberHandover: vi.fn(),
  updateOrg: vi.fn(),
  deleteOrg: vi.fn(),
  createOrgInvitation: vi.fn(),
  cancelOrgInvitation: vi.fn(),
  resendOrgInvitation: vi.fn(),
  listOrgDepartures: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ refreshOrganizations: mocks.refreshOrganizations }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "me@firm.example" } }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrg: mocks.getOrg,
  listOrgMembers: mocks.listOrgMembers,
  listOrgInvitations: mocks.listOrgInvitations,
  updateOrgMember: mocks.updateOrgMember,
  removeOrgMember: mocks.removeOrgMember,
  getOrgMemberHandover: mocks.getOrgMemberHandover,
  updateOrg: mocks.updateOrg,
  deleteOrg: mocks.deleteOrg,
  createOrgInvitation: mocks.createOrgInvitation,
  cancelOrgInvitation: mocks.cancelOrgInvitation,
  resendOrgInvitation: mocks.resendOrgInvitation,
  listOrgDepartures: mocks.listOrgDepartures,
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Nothing of theirs to hand over or delete, unless a test says otherwise.
  mocks.getOrgMemberHandover.mockResolvedValue({ projects: [], workflows: [], chats: 0, reviews: 0 });
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
  mocks.role = "owner";
  mocks.getOrg.mockImplementation(async () => ({
    id: "org-1",
    name: "Elite Law LLP",
    created_by: "me",
    role: mocks.role,
  }));
  mocks.listOrgMembers.mockResolvedValue([
    {
      id: "m1",
      user_id: "me",
      display_name: "William Chen",
      email: "me@firm.example",
      role: "owner",
      created_at: "2026-08-30T00:00:00Z",
    },
    {
      id: "m2",
      user_id: "u2",
      display_name: "Jane Lee",
      email: "jane@firm.example",
      role: "member",
      created_at: "2026-09-01T00:00:00Z",
    },
  ]);
  mocks.listOrgInvitations.mockResolvedValue([]);
  mocks.listOrgDepartures.mockResolvedValue({
    truncated: false,
    departures: [
      {
        key: "sam:1",
        member: {
          user_id: "sam",
          display_name: "Sam Park",
          email: "sam@firm.example",
        },
        departed_at: "2026-10-01T09:00:00Z",
        expires_at: "2099-01-01T00:00:00Z",
        items: [
          {
            id: "a1",
            kind: "chat",
            item_id: "c1",
            title: "Limitation periods",
            archived_at: "2026-10-01T09:00:00Z",
            expires_at: "2099-01-01T00:00:00Z",
          },
        ],
      },
    ],
  });
});

describe("the Departed view", () => {
  it("is a tab for owners, showing who left in place of the roster", async () => {
    const user = userEvent.setup();
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");
    expect(mocks.listOrgDepartures).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Departed" }));

    expect(await screen.findByText("Sam Park")).toBeInTheDocument();
    expect(mocks.listOrgDepartures).toHaveBeenCalledExactlyOnceWith("org-1");
    expect(screen.queryByText("William Chen")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Search departed members…" }),
    ).toBeInTheDocument();

    // And back to the roster.
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("William Chen")).toBeInTheDocument();
    expect(screen.queryByText("Sam Park")).not.toBeInTheDocument();
  });

  it("opens there from a link that leads to it", async () => {
    render(<OrganizationMembers orgId="org-1" initialTab="departed" />);

    expect(await screen.findByText("Sam Park")).toBeInTheDocument();
  });

  it.each(["admin", "member"] as const)(
    "is not offered to a %s, and a link to it opens the roster",
    async (role) => {
      mocks.role = role;
      render(<OrganizationMembers orgId="org-1" initialTab="departed" />);

      expect(await screen.findByText("William Chen")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Departed" }),
      ).not.toBeInTheDocument();
      expect(mocks.listOrgDepartures).not.toHaveBeenCalled();
    },
  );
});

describe("OrganizationMembers", () => {
  it("is a table page: the roster with its identity columns, under a header that leads back to settings", async () => {
    const user = userEvent.setup();
    render(<OrganizationMembers orgId="org-1" />);

    expect(await screen.findByText("William Chen")).toBeInTheDocument();
    expect(screen.getAllByText("Members")).not.toHaveLength(0);
    // The count sits beside the column's name.
    expect(screen.getByText("(2)")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Back to Organization" }),
    );
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-1/settings");
    expect(screen.getByText("me@firm.example")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select all people" }),
    ).toBeInTheDocument();
    // Roles are chosen from the tabs, not from a filter in the column.
    expect(
      screen.queryByRole("button", { name: "Filter by role" }),
    ).not.toBeInTheDocument();
    const peopleRow = screen
      .getByRole("checkbox", { name: "Select Jane Lee" })
      .closest(".group");
    expect(peopleRow).toHaveClass("liquid-glass-hover");
    expect(peopleRow).not.toHaveClass("cursor-pointer");

    // An organization's projects and workflows are in the main lists once
    // its workspace is active; they are not repeated here.
    for (const name of ["People", "Projects", "Workflows"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
  });

  describe("the roster's order and pages", () => {
    type Role = "owner" | "admin" | "member";
    const person = (name: string, role: Role, joined: string) => ({
      id: `m-${name}`,
      user_id: `u-${name}`,
      display_name: name,
      email: `${name.toLowerCase()}@firm.example`,
      role,
      created_at: joined,
    });
    // The names as the table lists them, top to bottom.
    const listed = () =>
      screen
        .getAllByRole("checkbox", { name: /^Select (?!all)/ })
        .map((box) => box.getAttribute("aria-label")!.replace("Select ", ""));

    it("lists owners, then admins, then members, each by name", async () => {
      // Handed over in no useful order, as the server returns them.
      mocks.listOrgMembers.mockResolvedValue([
        person("Zed", "member", "2026-01-01T00:00:00Z"),
        person("Olive", "owner", "2026-03-01T00:00:00Z"),
        person("Amy", "member", "2026-02-01T00:00:00Z"),
        person("Bob", "admin", "2026-04-01T00:00:00Z"),
        person("Abe", "owner", "2026-05-01T00:00:00Z"),
        person("Ada", "admin", "2026-06-01T00:00:00Z"),
      ]);
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive");

      expect(listed()).toEqual(["Abe", "Olive", "Ada", "Bob", "Amy", "Zed"]);
    });

    it("keeps that order under a column sort, which orders people within each role", async () => {
      const user = userEvent.setup();
      mocks.listOrgMembers.mockResolvedValue([
        person("Zed", "member", "2026-01-01T00:00:00Z"),
        person("Olive", "owner", "2026-03-01T00:00:00Z"),
        person("Amy", "member", "2026-02-01T00:00:00Z"),
        person("Abe", "owner", "2026-05-01T00:00:00Z"),
      ]);
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive");

      await user.click(
        screen.getByRole("button", { name: "Sort by name" }),
      );
      await user.click(screen.getByRole("menuitem", { name: "Descending" }));

      // Descending by name, but owners still come before members.
      expect(listed()).toEqual(["Olive", "Abe", "Zed", "Amy"]);
    });

    it("draws thirty people at a time, and more on request", async () => {
      const user = userEvent.setup();
      mocks.listOrgMembers.mockResolvedValue(
        Array.from({ length: 65 }, (_, index) =>
          person(
            `Person${String(index).padStart(2, "0")}`,
            "member",
            "2026-01-01T00:00:00Z",
          ),
        ),
      );
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Person00");

      expect(listed()).toHaveLength(30);
      // The count is of the list, not of what is drawn.
      expect(screen.getByText("(65)")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Load more" }));
      expect(listed()).toHaveLength(60);
      await user.click(screen.getByRole("button", { name: "Load more" }));
      expect(listed()).toHaveLength(65);
      // Nothing left to draw.
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument();
    });

    it("searches the whole roster, not only the page on screen, and starts the result from its first page", async () => {
      const user = userEvent.setup();
      mocks.listOrgMembers.mockResolvedValue(
        Array.from({ length: 65 }, (_, index) =>
          person(
            `Person${String(index).padStart(2, "0")}`,
            "member",
            "2026-01-01T00:00:00Z",
          ),
        ),
      );
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Person00");
      await user.click(screen.getByRole("button", { name: "Load more" }));
      expect(listed()).toHaveLength(60);

      await user.click(screen.getByRole("button", { name: "Search members…" }));
      // Person64 is on the third page, which has not been drawn.
      await user.type(screen.getByPlaceholderText("Search members…"), "person6");

      expect(listed()).toEqual([
        "Person60",
        "Person61",
        "Person62",
        "Person63",
        "Person64",
      ]);

      await user.clear(screen.getByPlaceholderText("Search members…"));
      expect(listed()).toHaveLength(30);
    });

    it("selects everyone who matches, drawn or not", async () => {
      const user = userEvent.setup();
      mocks.listOrgMembers.mockResolvedValue(
        Array.from({ length: 40 }, (_, index) =>
          person(
            `Person${String(index).padStart(2, "0")}`,
            "member",
            "2026-01-01T00:00:00Z",
          ),
        ),
      );
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Person00");

      await user.click(
        screen.getByRole("checkbox", { name: "Select all people" }),
      );
      await user.click(screen.getByRole("button", { name: "Load more" }));

      // The ten drawn afterwards were part of the selection all along.
      expect(
        screen.getByRole("checkbox", { name: "Select Person39" }),
      ).toBeChecked();
    });
  });

  describe("the role tabs", () => {
    const roster = [
      ["Olive", "owner"],
      ["Abe", "owner"],
      ["Ada", "admin"],
      ["Amy", "member"],
      ["Zed", "member"],
      ["Max", "member"],
    ].map(([name, role]) => ({
      id: `m-${name}`,
      user_id: `u-${name}`,
      display_name: name,
      email: `${name.toLowerCase()}@firm.example`,
      role,
      created_at: "2026-01-01T00:00:00Z",
    }));
    const listed = () =>
      screen
        .queryAllByRole("checkbox", { name: /^Select (?!all)/ })
        .map((box) => box.getAttribute("aria-label")!.replace("Select ", ""));
    const tab = (name: string) => screen.getByRole("button", { name });

    beforeEach(() => {
      mocks.listOrgMembers.mockResolvedValue(roster);
    });

    it("opens on everyone, with a tab for each role and no separate counter", async () => {
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive");

      for (const name of ["All", "Owners", "Admins", "Members"])
        expect(tab(name)).toBeInTheDocument();
      expect(listed()).toEqual(["Abe", "Olive", "Ada", "Amy", "Max", "Zed"]);
      expect(screen.getByText("(6)")).toBeInTheDocument();
      expect(screen.queryByText(/\d+ members?$/)).not.toBeInTheDocument();
    });

    it.each([
      ["Owners", ["Abe", "Olive"]],
      ["Admins", ["Ada"]],
      ["Members", ["Amy", "Max", "Zed"]],
    ])("shows only that role under %s, and counts it", async (name, people) => {
      const user = userEvent.setup();
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive");

      await user.click(tab(name));

      expect(listed()).toEqual(people);
      expect(
        screen.getByText(`(${people.length})`),
      ).toBeInTheDocument();
    });

    it("searches within the open tab, and counts the matches", async () => {
      const user = userEvent.setup();
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive");

      await user.click(tab("Members"));
      await user.click(screen.getByRole("button", { name: "Search members…" }));
      await user.type(screen.getByPlaceholderText("Search members…"), "ma");

      expect(listed()).toEqual(["Max"]);
      expect(screen.getByText("(1)")).toBeInTheDocument();

      // The search stays as the tab changes, and no owner matches it.
      await user.click(tab("Owners"));
      expect(listed()).toEqual([]);
      expect(
        screen.getByText("No people match this search."),
      ).toBeInTheDocument();
    });

    it("says so when nobody holds the role", async () => {
      const user = userEvent.setup();
      mocks.listOrgMembers.mockResolvedValue(
        roster.filter((person) => person.role !== "admin"),
      );
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive");

      await user.click(tab("Admins"));

      expect(
        screen.getByText("This organization has no admins."),
      ).toBeInTheDocument();
      expect(screen.getByText("(0)")).toBeInTheDocument();
    });

    it("drops a selection when the tab changes", async () => {
      const user = userEvent.setup();
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive");

      await user.click(screen.getByRole("checkbox", { name: "Select Amy" }));
      await user.click(tab("Owners"));
      await user.click(tab("All"));

      expect(
        screen.getByRole("checkbox", { name: "Select Amy" }),
      ).not.toBeChecked();
    });

    it("shows no count while the roster loads", () => {
      mocks.getOrg.mockReturnValue(new Promise(() => {}));
      render(<OrganizationMembers orgId="org-1" />);
      expect(screen.getByText("Name")).toBeInTheDocument();
      expect(screen.queryByText(/Name \(/)).not.toBeInTheDocument();
    });
  });

  it("narrows the roster from the header's search, by name or email", async () => {
    const user = userEvent.setup();
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Search members…" }));
    const search = screen.getByPlaceholderText("Search members…");
    await user.type(search, "jane@");

    expect(screen.getByText("Jane Lee")).toBeInTheDocument();
    expect(screen.queryByText("William Chen")).not.toBeInTheDocument();
    // The count follows the search.
    expect(screen.getByText("(1)")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "WILLIAM");
    expect(screen.getByText("William Chen")).toBeInTheDocument();
    expect(screen.queryByText("Jane Lee")).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "nobody");
    expect(
      screen.getByText("No people match this search."),
    ).toBeInTheDocument();
  });

  it("drops a selection when the search changes what is on screen", async () => {
    const user = userEvent.setup();
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("checkbox", { name: "Select Jane Lee" }));
    expect(
      screen.getByRole("checkbox", { name: "Select Jane Lee" }),
    ).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Search members…" }));
    await user.type(screen.getByPlaceholderText("Search members…"), "jane");

    expect(
      screen.getByRole("checkbox", { name: "Select Jane Lee" }),
    ).not.toBeChecked();
  });

  it("lets owners change a member's role from the colored role tab", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("Jane Lee");

    const roleTab = screen.getByRole("button", {
      name: "Change role for Jane Lee",
    });
    expect(roleTab).toHaveClass("bg-gray-100", "text-gray-600");
    await user.click(roleTab);
    await user.click(screen.getByRole("menuitem", { name: "Admin" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "u2",
        "admin",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Change role for Jane Lee" }),
    ).toHaveClass("bg-violet-100", "text-violet-700");
  });

  it("shows last-owner failures with the warning primitive", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockRejectedValue(
      new MikeApiError({
        status: 409,
        message: "An organization must keep at least one owner.",
      }),
    );
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Member" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText("An organization must keep at least one owner."),
    ).toBeInTheDocument();
    expect(screen.getByText("Organization action failed")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss warning" }),
    ).toBeInTheDocument();
  });

  it.each([["Jane Lee"], ["William Chen"], ["Jane Lee", "William Chen"]])("matches the toolbar and right-click people menu for %j", async (...names) => {
    const user = userEvent.setup();
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("Jane Lee");
    for (const name of names) await user.click(screen.getByRole("checkbox", { name: `Select ${name}` }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual([names.length > 1 ? "Remove all selected" : names[0] === "William Chen" ? "Leave organization" : "Remove member"]);
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(screen.getByText(names[0]), { clientX: 40, clientY: 40 });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(items);
  });

  it("reveals a toolbar action and removes selected people", async () => {
    const user = userEvent.setup();
    mocks.removeOrgMember.mockResolvedValue(undefined);
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("Jane Lee");

    expect(
      screen.queryByRole("button", { name: "Actions" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select Jane Lee" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const removeAction = screen.getByRole("menuitem", {
      name: "Remove member",
    });
    expect(removeAction).toHaveClass("text-red-600");
    await user.click(removeAction);

    // The dialog first asks what removing her would hand over and delete.
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Jane Lee will lose organization access."),
    ).toBeInTheDocument();
    expect(mocks.getOrgMemberHandover).toHaveBeenCalledWith("org-1", "u2");
    const remove = within(dialog).getByRole("button", { name: "Remove" });
    await waitFor(() => expect(remove).toBeEnabled());
    await user.click(remove);
    await waitFor(() =>
      expect(mocks.removeOrgMember).toHaveBeenCalledWith(
        "org-1",
        "u2",
        undefined,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText("Jane Lee")).not.toBeInTheDocument(),
    );
  });

  it("warns an owner who includes themselves in bulk removal", async () => {
    const user = userEvent.setup();
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("checkbox", { name: "Select William Chen" }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Select Jane Lee" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove all selected" }),
    );

    // The refusal is about the route, not about owner arithmetic: leaving is
    // a different action, and saying "must keep at least one owner" was wrong
    // however many owners the organization had.
    expect(
      await screen.findByText("Use Leave organization to remove yourself."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("An organization must keep at least one owner."),
    ).not.toBeInTheDocument();
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
  });

  it("lets an owner or admin add a member from the header's + button", async () => {
    const user = userEvent.setup();
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    expect(screen.getByText("Email address")).toBeInTheDocument();
    expect(mocks.listOrgInvitations).toHaveBeenCalledWith("org-1");
  });

  it("drops owner and admin controls as soon as an owner demotes themselves", async () => {
    const user = userEvent.setup();
    const onViewerRoleChanged = vi.fn();
    mocks.updateOrgMember.mockResolvedValue({});
    render(
      <OrganizationMembers
        orgId="org-1"
        onViewerRoleChanged={onViewerRoleChanged}
      />,
    );
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Member" }));

    // Losing your own owner rights is confirmed before it happens.
    expect(screen.getByText("Give up owner access?")).toBeInTheDocument();
    expect(mocks.updateOrgMember).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "me",
        "member",
      ),
    );
    // org.role has to follow the membership row, or the page keeps offering
    // admin actions that now 403 until a reload.
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Only organization admins can add members",
        }),
      ).toBeDisabled(),
    );
    expect(
      screen.queryByRole("button", { name: "Change role for Jane Lee" }),
    ).not.toBeInTheDocument();
    expect(mocks.getOrg).toHaveBeenCalledTimes(1);
    // The settings area and the workspace switcher both show the role, and
    // offer a member fewer sections.
    expect(onViewerRoleChanged).toHaveBeenCalledTimes(1);
    expect(mocks.refreshOrganizations).toHaveBeenCalled();
  });

  it("keeps the self-demotion confirmation up while the change is in flight", async () => {
    // The popup was closed before the request was sent, so the busy state it
    // is handed could never render and the click read as a no-op.
    const user = userEvent.setup();
    let settle: (() => void) | undefined;
    mocks.updateOrgMember.mockImplementation(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          settle = () => resolve({});
        }),
    );
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Member" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByText("Give up owner access?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continuing..." })).toBeDisabled();

    settle?.();

    await waitFor(() =>
      expect(screen.queryByText("Give up owner access?")).not.toBeInTheDocument(),
    );
  });

  it("does not report a sent invitation as failed when the refresh rejects", async () => {
    const user = userEvent.setup();
    mocks.createOrgInvitation.mockResolvedValue({});
    mocks.listOrgInvitations
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("refresh failed"));
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    // ModalUI settles focus a frame after the dialog opens (the auto-focused
    // field keeps it, else the first control); typing across that handoff
    // loses the tail of the address, so wait for focus to land in the dialog.
    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    await user.type(
      screen.getByPlaceholderText("Invite by email…"),
      "new@firm.example",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(mocks.createOrgInvitation).toHaveBeenCalledWith(
        "org-1",
        "new@firm.example",
        "member",
      ),
    );
    expect(
      await screen.findByText("Invitation sent to new@firm.example."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Could not send the invitation."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Invitation action failed"),
    ).not.toBeInTheDocument();
  });

  it("re-reads invitations and the roster when the Add member modal opens", async () => {
    // An invitation is accepted in the recipient's browser, so this page never
    // hears about it. Opening Add member used to redisplay the list loaded at
    // page load, which still called the new colleague "Pending" — and the
    // People table behind it still did not have them at all.
    const user = userEvent.setup();
    const invitation = {
      id: "i1",
      org_id: "org-1",
      email: "newjoiner@firm.example",
      role: "member" as const,
      invited_by: "me",
      expires_at: "2026-09-30T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
      accepted_at: null,
      declined_at: null,
      cancelled_at: null,
    };
    const joiner = {
      id: "m3",
      user_id: "u3",
      display_name: "New Joiner",
      email: "newjoiner@firm.example",
      role: "member",
      created_at: "2026-09-02T00:00:00Z",
    };
    mocks.listOrgInvitations
      .mockResolvedValueOnce([{ ...invitation, status: "pending" }])
      .mockResolvedValue([
        {
          ...invitation,
          status: "accepted",
          accepted_at: "2026-09-02T00:00:00Z",
        },
      ]);
    const initialMembers = [
      {
        id: "m1",
        user_id: "me",
        display_name: "William Chen",
        email: "me@firm.example",
        role: "owner",
        created_at: "2026-08-30T00:00:00Z",
      },
    ];
    mocks.listOrgMembers
      .mockResolvedValueOnce(initialMembers)
      .mockResolvedValue([...initialMembers, joiner]);

    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");
    expect(screen.queryByText("New Joiner")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() =>
      expect(mocks.listOrgInvitations).toHaveBeenCalledTimes(2),
    );
    // The accepted invitation is no longer pending, so its row is gone...
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: "Cancel invitation to newjoiner@firm.example",
        }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("Pending invitations")).not.toBeInTheDocument();
    // ...and the same person is now on the roster without a reload.
    expect(screen.getByText("New Joiner")).toBeInTheDocument();
  });

  it("ignores a stale roster response that answers after a newer one", async () => {
    // Two readers write this roster — the page load and the refresh that runs
    // whenever the Add member modal opens or closes — and nothing ordered
    // them. Whichever response landed LAST won: a three-person roster was
    // seen collapsing to one when the older answer came back second.
    const user = userEvent.setup();
    const chen = {
      id: "m1",
      user_id: "me",
      display_name: "William Chen",
      email: "me@firm.example",
      role: "owner",
      created_at: "2026-08-30T00:00:00Z",
    };
    const lee = {
      id: "m2",
      user_id: "u2",
      display_name: "Jane Lee",
      email: "jane@firm.example",
      role: "member",
      created_at: "2026-09-01T00:00:00Z",
    };
    const joiner = {
      id: "m3",
      user_id: "u3",
      display_name: "New Joiner",
      email: "newjoiner@firm.example",
      role: "member",
      created_at: "2026-09-02T00:00:00Z",
    };
    const stale: { release: (members: unknown[]) => void } = {
      release: () => {},
    };
    mocks.listOrgMembers
      // The page load.
      .mockResolvedValueOnce([chen, lee])
      // Opening the modal: this read is overtaken and must not be applied.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            stale.release = resolve;
          }),
      )
      // Closing it: the newest answer, and the one the table must keep.
      .mockResolvedValue([chen, lee, joiner]);

    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Add member" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    // The close path re-reads BOTH lists, not the roster alone.
    await waitFor(() => expect(screen.getByText("New Joiner")).toBeInTheDocument());
    expect(mocks.listOrgInvitations.mock.calls.length).toBeGreaterThan(2);

    // Now the overtaken read finally answers, with the roster as it was.
    stale.release([chen]);
    await waitFor(() =>
      expect(mocks.listOrgMembers).toHaveBeenCalledTimes(3),
    );
    expect(screen.getByText("New Joiner")).toBeInTheDocument();
    expect(screen.getByText("Jane Lee")).toBeInTheDocument();
  });

  it("says so when refreshing the people lists fails", async () => {
    // A console line is not a user interface. The admin was left reading a
    // roster that had quietly stopped tracking the server.
    const user = userEvent.setup();
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");
    // The page loaded; it is the refresh behind the modal that fails.
    mocks.listOrgMembers.mockRejectedValue(new Error("network"));

    await user.click(screen.getByRole("button", { name: "Add member" }));

    expect(
      await screen.findByText("Organization action failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This organization's people could not be refreshed. Reload to see the current list.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a member the roster, without the means to add people or the invitations", async () => {
    mocks.role = "member";
    render(<OrganizationMembers orgId="org-1" />);

    expect(await screen.findByText("William Chen")).toBeInTheDocument();
    expect(screen.getByText("Jane Lee")).toBeInTheDocument();
    expect(mocks.listOrgInvitations).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "Only organization admins can add members",
      }),
    ).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // An admin runs the organization day to day; an owner decides who does.
  // The server refuses each of these, so offering them only produced a 403.
  // -------------------------------------------------------------------------
  describe("as an admin who is not an owner", () => {
    beforeEach(() => {
      mocks.role = "admin";
      mocks.listOrgMembers.mockResolvedValue([
        {
          id: "m1",
          user_id: "me",
          display_name: "William Chen",
          email: "me@firm.example",
          role: "admin",
          created_at: "2026-08-30T00:00:00Z",
        },
        {
          id: "m2",
          user_id: "u2",
          display_name: "Jane Lee",
          email: "jane@firm.example",
          role: "member",
          created_at: "2026-09-01T00:00:00Z",
        },
        {
          id: "m3",
          user_id: "u3",
          display_name: "Olive Owner",
          email: "olive@firm.example",
          role: "owner",
          created_at: "2026-08-01T00:00:00Z",
        },
        {
          id: "m4",
          user_id: "u4",
          display_name: "Adam Admin",
          email: "adam@firm.example",
          role: "admin",
          created_at: "2026-08-02T00:00:00Z",
        },
      ]);
    });

    it("shows every role as plain text, because none of them is theirs to change", async () => {
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive Owner");

      for (const name of [
        "William Chen",
        "Jane Lee",
        "Olive Owner",
        "Adam Admin",
      ]) {
        expect(
          screen.queryByRole("button", { name: `Change role for ${name}` }),
        ).not.toBeInTheDocument();
      }
      expect(screen.getByText("Owner")).toHaveClass(
        "bg-blue-100",
        "text-blue-700",
      );
    });

    it("offers removal for members and for themselves only", async () => {
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive Owner");

      expect(
        screen.getByRole("button", { name: "Actions for Jane Lee" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Actions for William Chen" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Actions for Olive Owner" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Actions for Adam Admin" }),
      ).not.toBeInTheDocument();

      // The right-click menu is the same decision reached another way.
      fireEvent.contextMenu(screen.getByText("Olive Owner"), {
        clientX: 40,
        clientY: 40,
      });
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    });

    it("refuses a bulk removal that includes an owner or another admin", async () => {
      const user = userEvent.setup();
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive Owner");

      await user.click(
        screen.getByRole("checkbox", { name: "Select Jane Lee" }),
      );
      await user.click(
        screen.getByRole("checkbox", { name: "Select Olive Owner" }),
      );
      await user.click(screen.getByRole("button", { name: "Actions" }));
      await user.click(
        screen.getByRole("menuitem", { name: "Remove all selected" }),
      );

      expect(
        await screen.findByText(
          "Only an organization owner can remove admins and other owners.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Remove selected people?"),
      ).not.toBeInTheDocument();
      expect(mocks.removeOrgMember).not.toHaveBeenCalled();
    });

    it("invites members only, and leaves an owner's admin invitation alone", async () => {
      const user = userEvent.setup();
      mocks.listOrgInvitations.mockResolvedValue([
        {
          id: "i1",
          org_id: "org-1",
          email: "partner@firm.example",
          role: "admin",
          invited_by: "u3",
          status: "pending",
          expires_at: "2026-12-01T00:00:00Z",
          created_at: "2026-10-01T00:00:00Z",
          accepted_at: null,
        },
        {
          id: "i2",
          org_id: "org-1",
          email: "associate@firm.example",
          role: "member",
          invited_by: "me",
          status: "pending",
          expires_at: "2026-12-01T00:00:00Z",
          created_at: "2026-10-01T00:00:00Z",
          accepted_at: null,
        },
      ]);
      render(<OrganizationMembers orgId="org-1" />);
      await screen.findByText("Olive Owner");

      await user.click(screen.getByRole("button", { name: "Add member" }));
      // No picker: Member is the only role an admin may hand out.
      expect(screen.queryByLabelText("Role")).not.toBeInTheDocument();
      expect(
        screen.getByText(/Only an organization owner can invite admins\./),
      ).toBeInTheDocument();

      expect(
        screen.getByRole("button", {
          name: "Resend invitation to partner@firm.example",
        }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", {
          name: "Cancel invitation to partner@firm.example",
        }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", {
          name: "Cancel invitation to associate@firm.example",
        }),
      ).toBeEnabled();
    });
  });

  it("lets an owner hand out every role, ownership included", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("Jane Lee");

    await user.click(
      screen.getByRole("button", { name: "Change role for Jane Lee" }),
    );
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Owner", "Admin", "Member"]);
    await user.click(screen.getByRole("menuitem", { name: "Owner" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "u2",
        "owner",
      ),
    );
  });

  it("words an owner stepping down to admin as losing ownership, not administration", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(<OrganizationMembers orgId="org-1" />);
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Change role for William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Admin" }));

    expect(screen.getByText("Step down to admin?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "me",
        "admin",
      ),
    );
    // Still an admin: settings stay, deletion and role changes go.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Change role for Jane Lee" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Add member" })).toBeEnabled();
  });
});
