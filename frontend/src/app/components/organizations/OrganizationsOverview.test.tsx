import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError } from "@/app/lib/mikeApi";
import { OrganizationsOverview } from "./OrganizationsOverview";
import SettingsLayout from "@/app/(pages)/settings/layout";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  // The workspace the person is in: "personal" or an organization's id.
  workspaceId: "org-1" as string | null,
  setWorkspace: vi.fn(),
  refreshOrganizations: vi.fn(async () => {}),
  listOrgs: vi.fn(),
  listMyOrgInvitations: vi.fn(),
  createOrg: vi.fn(),
  createOrgInvitation: vi.fn(),
  acceptOrgInvitation: vi.fn(),
  declineOrgInvitation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/organizations",
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "me" },
    isAuthenticated: true,
    authLoading: false,
  }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({
    workspaceId: mocks.workspaceId,
    setWorkspace: mocks.setWorkspace,
    refreshOrganizations: mocks.refreshOrganizations,
  }),
}));
// Spread the real module: userFacingApiError resolves MikeApiError from this
// same module, so a bare object mock leaves its `instanceof` check with an
// undefined right-hand side.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  listOrgs: mocks.listOrgs,
  listDeletedOrganizations: vi.fn(async () => []),
  listMyOrgInvitations: mocks.listMyOrgInvitations,
  createOrg: mocks.createOrg,
  createOrgInvitation: mocks.createOrgInvitation,
  acceptOrgInvitation: mocks.acceptOrgInvitation,
  declineOrgInvitation: mocks.declineOrgInvitation,
}));

const ORG = {
  id: "org-1",
  name: "Elite Law LLP",
  created_by: "me",
  created_at: "2026-09-01T00:00:00.000Z",
  role: "admin" as const,
  member_count: 3,
};

const JOINED_ORG = {
  ...ORG,
  id: "org-joined",
  name: "Community Legal",
  role: "member" as const,
  member_count: 8,
};

const INVITATION = {
  id: "invite-1",
  org_id: "org-invited",
  org_name: "Inviting Chambers",
  email: "me@example.com",
  role: "member" as const,
  invited_by: "inviter-1",
  status: "pending" as const,
  expires_at: "2026-09-10T00:00:00.000Z",
  created_at: "2026-09-01T00:00:00.000Z",
  accepted_at: null,
  declined_at: null,
  cancelled_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceId = "org-1";
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
  mocks.listOrgs.mockResolvedValue([ORG]);
  mocks.listMyOrgInvitations.mockResolvedValue([]);
});

/**
 * ModalUI settles focus on the frame after the dialog opens: the control
 * React auto-focused keeps it, otherwise the first focusable control gets it.
 * Typing before that handoff lands the tail of the text on whichever control
 * wins, so wait until focus has left <body> and sits inside the dialog.
 */
async function settleModalFocus() {
  await waitFor(() => {
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).not.toBe(document.body);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
}

describe("OrganizationsOverview", () => {
  const card = (name: string) =>
    screen.getByRole("region", { name: `${name} organization` });

  it("lists organizations as settings cards, with the person's role and the size of each", async () => {
    mocks.listOrgs.mockResolvedValue([ORG, JOINED_ORG]);
    render(<OrganizationsOverview />);

    expect(await screen.findByText("Elite Law LLP")).toBeInTheDocument();
    expect(within(card("Elite Law LLP")).getByText("Admin · 3 members")).toBeInTheDocument();
    expect(
      within(card("Community Legal")).getByText("Member · 8 members"),
    ).toBeInTheDocument();
    // Cards, not a table: no tabs, no column sorts, no rows.
    for (const name of ["Managing", "Joined", "Invites"])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sort by organization name" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says one member, not one members", async () => {
    mocks.listOrgs.mockResolvedValue([{ ...ORG, member_count: 1 }]);
    render(<OrganizationsOverview />);
    expect(await screen.findByText("Admin · 1 member")).toBeInTheDocument();
  });

  it("puts the workspace the person is in first, then the rest by name", async () => {
    mocks.workspaceId = "org-joined";
    mocks.listOrgs.mockResolvedValue([
      { ...ORG, id: "org-z", name: "Zeta LLP" },
      { ...ORG, id: "org-a", name: "Alpha LLP" },
      JOINED_ORG,
    ]);
    render(<OrganizationsOverview />);
    await screen.findByText("Zeta LLP");

    expect(
      screen
        .getAllByRole("region", { name: / organization$/ })
        .map((region) => region.getAttribute("aria-label")),
    ).toEqual([
      "Community Legal organization",
      "Alpha LLP organization",
      "Zeta LLP organization",
    ]);
  });

  it("opens the settings of the workspace the person is in from its blue Manage button", async () => {
    const user = userEvent.setup();
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    const manage = within(card("Elite Law LLP")).getByRole("button", {
      name: "Manage Elite Law LLP",
    });
    expect(manage).toHaveTextContent("Manage");
    expect(manage.className).toMatch(/bg-blue-/);
    // The card itself is not a second way in.
    expect(
      screen.getAllByRole("button", { name: "Manage Elite Law LLP" }),
    ).toHaveLength(1);

    await user.click(manage);
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-1/settings");
  });

  describe("an organization that is not the workspace the person is in", () => {
    const SECOND = { ...ORG, id: "org-2", name: "Beta Chambers" };

    beforeEach(() => {
      mocks.listOrgs.mockResolvedValue([ORG, SECOND]);
    });

    it("does not open its settings from here", async () => {
      const user = userEvent.setup();
      render(<OrganizationsOverview />);
      await screen.findByText("Beta Chambers");

      // Only the current workspace's card opens anything.
      expect(
        screen.queryByRole("button", { name: "Manage Beta Chambers" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByText("Beta Chambers"));
      expect(mocks.push).not.toHaveBeenCalled();
    });

    it("offers a black Switch button to its workspace instead", async () => {
      const user = userEvent.setup();
      render(<OrganizationsOverview />);
      await screen.findByText("Beta Chambers");

      const switchButton = screen.getByRole("button", {
        name: "Switch to Beta Chambers",
      });
      expect(switchButton.className).toMatch(/bg-gray-950/);
      await user.click(switchButton);

      expect(mocks.setWorkspace).toHaveBeenCalledExactlyOnceWith("org-2");
      // Switching is not opening: the person stays on their list.
      expect(mocks.push).not.toHaveBeenCalled();
      // The current workspace has nothing to switch to.
      expect(
        screen.queryByRole("button", { name: "Switch to Elite Law LLP" }),
      ).not.toBeInTheDocument();
    });

    it("opens no organization's settings from the personal workspace", async () => {
      mocks.workspaceId = "personal";
      render(<OrganizationsOverview />);
      await screen.findByText("Beta Chambers");

      expect(
        screen.queryByRole("button", { name: /^Manage / }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Switch to Elite Law LLP" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Switch to Beta Chambers" }),
      ).toBeInTheDocument();
    });
  });

  it("sets the New organization button like the connectors' Custom button", async () => {
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    const button = screen.getByRole("button", { name: "New organization" });
    // The compact pill beside the section heading: short label, plus icon.
    expect(button).toHaveTextContent("New");
    expect(button).toHaveClass("h-7", "liquid-glass-subtle");
    expect(button.querySelector("svg")).not.toBeNull();
  });

  it("creates an organization from the New organization button", async () => {
    const user = userEvent.setup();
    mocks.createOrg.mockResolvedValue({
      ...ORG,
      id: "org-2",
      name: "New Chambers",
    });
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "New organization" }));
    expect(
      await screen.findByText(/You can also add people later/),
    ).toBeInTheDocument();
    await settleModalFocus();
    await user.type(screen.getByLabelText("Organization name"), "New Chambers");
    await user.type(
      screen.getByPlaceholderText("Add member by email…"),
      "jane@firm.example",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mocks.createOrg).toHaveBeenCalledWith("New Chambers"),
    );
    expect(mocks.createOrgInvitation).toHaveBeenCalledWith(
      "org-2",
      "jane@firm.example",
      "member",
    );
    // A new organization is a new workspace to switch to. Its settings
    // open from there, so creating one does not navigate into them.
    expect(mocks.refreshOrganizations).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // The list is re-read so the new organization appears in it.
    expect(mocks.listOrgs.mock.calls.length).toBeGreaterThan(1);
  });

  it("says so when the person belongs to no organization", async () => {
    mocks.listOrgs.mockResolvedValue([]);
    render(<OrganizationsOverview />);

    expect(
      await screen.findByText(/No organizations yet\. Create one/),
    ).toBeInTheDocument();
    // An empty inbox needs no section of its own.
    expect(
      screen.queryByRole("heading", { name: "Invitations" }),
    ).not.toBeInTheDocument();
  });

  it("shows invitations in their own section, and answers one", async () => {
    const user = userEvent.setup();
    mocks.listMyOrgInvitations.mockResolvedValueOnce([INVITATION]);
    mocks.acceptOrgInvitation.mockResolvedValue(undefined);
    render(<OrganizationsOverview />);

    expect(
      await screen.findByRole("heading", { name: "Invitations" }),
    ).toBeInTheDocument();
    const invitation = screen.getByRole("region", {
      name: "Inviting Chambers invitation",
    });
    expect(
      within(invitation).getByText("Invited you as Member"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Accept Inviting Chambers" }),
    );
    await waitFor(() =>
      expect(mocks.acceptOrgInvitation).toHaveBeenCalledWith("invite-1"),
    );
    // Answered: the section goes with the last invitation, and an accepted
    // one is a new workspace to switch to.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Invitations" }),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalled();
  });

  it("declines an invitation", async () => {
    const user = userEvent.setup();
    mocks.listMyOrgInvitations.mockResolvedValueOnce([INVITATION]);
    mocks.declineOrgInvitation.mockResolvedValue(undefined);
    render(<OrganizationsOverview />);

    await user.click(
      await screen.findByRole("button", { name: "Decline Inviting Chambers" }),
    );
    await waitFor(() =>
      expect(mocks.declineOrgInvitation).toHaveBeenCalledWith("invite-1"),
    );
    expect(mocks.acceptOrgInvitation).not.toHaveBeenCalled();
  });

  it.each(["Accept", "Decline"])("clears the settings count after %s of the last invitation", async (action) => {
    const user = userEvent.setup();
    mocks.listMyOrgInvitations.mockResolvedValue([INVITATION]);
    const answer = action === "Accept" ? mocks.acceptOrgInvitation : mocks.declineOrgInvitation;
    answer.mockImplementation(async () => {
      mocks.listMyOrgInvitations.mockResolvedValue([]);
    });
    render(<SettingsLayout><OrganizationsOverview /></SettingsLayout>);

    expect(await screen.findByRole("button", {
      name: "Organizations 1 pending invitation",
    })).toBeVisible();
    await user.click(await screen.findByRole("button", {
      name: `${action} Inviting Chambers`,
    }));
    expect(await screen.findByRole("button", { name: "Organizations" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Invitations" })).not.toBeInTheDocument();
  });

  it("reports a failed invitations fetch instead of claiming there are none", async () => {
    const user = userEvent.setup();
    mocks.listMyOrgInvitations
      .mockRejectedValueOnce(
        new MikeApiError({ status: 503, message: "upstream down" }),
      )
      .mockResolvedValue([INVITATION]);
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    // A failed read is not an empty inbox: the section appears to say so.
    expect(
      screen.getByRole("heading", { name: "Invitations" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Could not load your invitations."),
    ).toBeInTheDocument();
    // The organizations half is untouched by the invitations half failing.
    expect(card("Elite Law LLP")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Inviting Chambers")).toBeInTheDocument();
  });

  it("shows the server's own wording when the organizations fetch is refused, with a retry", async () => {
    const user = userEvent.setup();
    mocks.listOrgs.mockRejectedValueOnce(
      new MikeApiError({
        status: 403,
        message: "Your account is not permitted to list organizations",
      }),
    );
    render(<OrganizationsOverview />);

    expect(
      await screen.findByText(
        "Your account is not permitted to list organizations",
      ),
    ).toBeInTheDocument();
    // Not "you have none": that would be a different thing to be told.
    expect(screen.queryByText(/No organizations yet/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Elite Law LLP")).toBeInTheDocument();
  });

  it("keeps a failing reload from being reported as a failed answer", async () => {
    // The re-read is bookkeeping that runs after the server has already
    // accepted, so it sits outside the try: a failure there must not become
    // "Could not answer that invitation" about an invitation that was taken.
    const user = userEvent.setup();
    mocks.listMyOrgInvitations.mockResolvedValueOnce([INVITATION]);
    mocks.acceptOrgInvitation.mockResolvedValue(undefined);
    render(<OrganizationsOverview />);

    const accept = await screen.findByRole("button", {
      name: "Accept Inviting Chambers",
    });
    mocks.listOrgs.mockRejectedValue(new Error("network"));
    mocks.listMyOrgInvitations.mockRejectedValue(new Error("network"));
    await user.click(accept);

    await waitFor(() =>
      expect(mocks.acceptOrgInvitation).toHaveBeenCalledWith("invite-1"),
    );
    expect(
      screen.queryByText("Could not answer that invitation."),
    ).not.toBeInTheDocument();
  });

  it("says so when an invitation could not be answered", async () => {
    const user = userEvent.setup();
    mocks.listMyOrgInvitations.mockResolvedValue([INVITATION]);
    mocks.acceptOrgInvitation.mockRejectedValue(new Error("boom"));
    render(<OrganizationsOverview />);

    await user.click(
      await screen.findByRole("button", { name: "Accept Inviting Chambers" }),
    );

    expect(
      await screen.findByText("Could not answer that invitation."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });

  it("keeps a partly failed creation from vanishing when the modal is closed", async () => {
    const user = userEvent.setup();
    const created = { ...ORG, id: "org-2", name: "New Chambers" };
    mocks.createOrg.mockResolvedValue(created);
    mocks.createOrgInvitation.mockRejectedValue(new Error("invite failed"));
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "New organization" }));
    await settleModalFocus();
    await user.type(screen.getByLabelText("Organization name"), "New Chambers");
    await user.type(
      screen.getByPlaceholderText("Add member by email…"),
      "jane@firm.example",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("Some invitations were not sent"),
    ).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();

    // The organization exists on the server but never reached onCreated, so
    // dismissal has to refetch or the card stays invisible until a reload.
    mocks.listOrgs.mockResolvedValue([ORG, created]);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(await screen.findByText("New Chambers")).toBeInTheDocument();
  });

  it("refuses to dismiss the create modal while the request is in flight", async () => {
    const user = userEvent.setup();
    mocks.createOrg.mockReturnValue(new Promise(() => {}));
    render(<OrganizationsOverview />);
    await screen.findByText("Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "New organization" }));
    await settleModalFocus();
    await user.type(screen.getByLabelText("Organization name"), "New Chambers");
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mocks.createOrg).toHaveBeenCalled());

    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "New organization" }),
    ).toBeInTheDocument();
  });

  it("draws placeholder cards, with nothing to press, while it loads", () => {
    mocks.listOrgs.mockReturnValue(new Promise(() => {}));
    mocks.listMyOrgInvitations.mockReturnValue(new Promise(() => {}));
    const { container } = render(<OrganizationsOverview />);

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /^(Switch to|Manage) / }),
    ).not.toBeInTheDocument();
    // Starting a new one does not depend on the list.
    expect(
      screen.getByRole("button", { name: "New organization" }),
    ).toBeEnabled();
  });
});
