import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { MikeApiError } from "@/app/lib/mikeApi";
import { OrganizationProvidersSettings } from "./OrganizationProvidersSettings";
import {
  OrganizationSettingsFrame,
  OrganizationSettingsProvider,
  organizationSettingsHref,
  useOrganizationSettings,
} from "./OrganizationSettingsShell";

// The frame around an organization's settings, and the one section in it
// that is not every member's: who is offered which sections, what a member
// who follows a link to Bring Your Own Keys is told, and what the sections are
// handed.

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  pathname: "/organizations/org-1/settings",
  role: "owner" as "owner" | "admin" | "member",
  getOrg: vi.fn(),
  // The workspace the caller is in, and the organizations they belong to.
  workspaceId: "org-1" as string | null,
  organizations: [] as { id: string; name: string; role: string }[] | null,
  setWorkspace: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  usePathname: () => mocks.pathname,
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  PERSONAL_WORKSPACE: "personal",
  PERSONAL_WORKSPACE_LABEL: "Personal",
  useWorkspace: () => ({
    workspaceId: mocks.workspaceId,
    organizations: mocks.organizations,
    setWorkspace: mocks.setWorkspace,
  }),
}));
vi.mock("@/shared/lib/toastStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/toastStore")>()),
  showToast: mocks.showToast,
}));
vi.mock("./OrganizationProviderKeys", () => ({
  OrganizationProviderKeys: ({ orgName }: { orgName: string }) => (
    <div data-testid="provider-keys">{orgName}</div>
  ),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrg: mocks.getOrg,
}));

// What a section sees, published from an effect so a test can call it.
let latest: ReturnType<typeof useOrganizationSettings>;
function Section() {
  const value = useOrganizationSettings();
  useEffect(() => {
    latest = value;
  });
  return <p>section for {value.org?.name ?? "…"}</p>;
}

// As the routes compose them: the provider around everything under
// settings, the frame around the pages that sit inside it.
const renderShell = (children = <Section />) =>
  render(
    <OrganizationSettingsProvider orgId="org-1">
      <OrganizationSettingsFrame>{children}</OrganizationSettingsFrame>
    </OrganizationSettingsProvider>,
  );
const sections = () =>
  within(screen.getByRole("navigation", { name: "Organization" }))
    .getAllByRole("button")
    .map((button) => button.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/organizations/org-1/settings";
  mocks.role = "owner";
  mocks.workspaceId = "org-1";
  mocks.organizations = [
    { id: "org-1", name: "Elite Law LLP", role: "owner" },
    { id: "org-2", name: "Beta Chambers", role: "member" },
  ];
  mocks.getOrg.mockImplementation(async () => ({
    id: "org-1",
    name: "Elite Law LLP",
    created_by: "me",
    role: mocks.role,
  }));
});

describe("the sections each role is offered", () => {
  it("offers an owner General, Members, Bring Your Own Keys and Privacy & Data", async () => {
    mocks.role = "owner";
    renderShell();
    await screen.findByText("section for Elite Law LLP");
    expect(sections()).toEqual([
      "General",
      "Members",
      "Audit log",
      "Bring Your Own Keys",
      "Privacy & Data",
    ]);
  });

  it("offers an admin General, Members and Bring Your Own Keys, not Privacy & Data", async () => {
    mocks.role = "admin";
    renderShell();
    await screen.findByText("section for Elite Law LLP");
    expect(sections()).toEqual(["General", "Members", "Audit log", "Bring Your Own Keys"]);
  });

  it("offers a member General and Members only", async () => {
    mocks.role = "member";
    renderShell();
    await screen.findByText("section for Elite Law LLP");
    expect(sections()).toEqual(["General", "Members"]);
  });

  it("does not offer Bring Your Own Keys before the caller's role is known", () => {
    mocks.getOrg.mockReturnValue(new Promise(() => {}));
    renderShell();
    expect(sections()).toEqual(["General", "Members"]);
  });

  it("drops Bring Your Own Keys as soon as a re-read shows the caller was demoted", async () => {
    renderShell();
    await screen.findByText("section for Elite Law LLP");
    expect(sections()).toContain("Bring Your Own Keys");

    mocks.role = "member";
    await act(() => latest.reload());

    expect(sections()).toEqual(["General", "Members"]);
  });
});

describe("the frame", () => {
  it("is headed Organization, whichever organization it is", async () => {
    renderShell();
    // Before the organization has loaded, and after.
    expect(
      screen.getByRole("heading", { level: 1, name: "Organization" }),
    ).toBeInTheDocument();
    await screen.findByText("section for Elite Law LLP");
    expect(
      screen.getByRole("heading", { level: 1, name: "Organization" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Elite Law LLP" }),
    ).not.toBeInTheDocument();
  });

  it("marks the open section, and General only on its own page", async () => {
    mocks.pathname = "/organizations/org-1/settings/members";
    renderShell();
    await screen.findByText("section for Elite Law LLP");

    expect(screen.getByRole("button", { name: "Members" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // General's path is a prefix of every section's.
    expect(screen.getByRole("button", { name: "General" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("opens a section by its address", async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByText("section for Elite Law LLP");

    await user.click(screen.getByRole("button", { name: "Bring Your Own Keys" }));

    expect(mocks.push).toHaveBeenCalledWith(
      "/organizations/org-1/settings/providers",
    );
    expect(organizationSettingsHref("org-1")).toBe(
      "/organizations/org-1/settings",
    );
    expect(organizationSettingsHref("org-1", "members")).toBe(
      "/organizations/org-1/settings/members",
    );
  });

  it("lets a section put a renamed organization in place", async () => {
    renderShell();
    await screen.findByText("section for Elite Law LLP");

    act(() => latest.setOrg({ ...latest.org!, name: "Elite Law Group" }));

    expect(screen.getByText("section for Elite Law Group")).toBeInTheDocument();
  });

  it("shares the organization with a page outside the frame, such as Members", async () => {
    // Members is a full table page: inside the provider, not the frame.
    render(
      <OrganizationSettingsProvider orgId="org-1">
        <Section />
      </OrganizationSettingsProvider>,
    );
    expect(
      await screen.findByText("section for Elite Law LLP"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(mocks.getOrg).toHaveBeenCalledExactlyOnceWith("org-1");
  });

  it("tells somebody outside the organization nothing about it, and offers a retry", async () => {
    const user = userEvent.setup();
    mocks.getOrg.mockRejectedValueOnce(
      new MikeApiError({ message: "Organization not found", status: 404 }),
    );
    renderShell();

    expect(
      await screen.findByText("Organization not found"),
    ).toBeInTheDocument();
    // No frame and no sections: there is no area to show.
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText(/section for/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText("section for Elite Law LLP"),
    ).toBeInTheDocument();
  });

  it("does not show an internal error to the page", async () => {
    mocks.getOrg.mockRejectedValueOnce(new Error("ECONNREFUSED 10.0.0.4"));
    renderShell();
    expect(
      await screen.findByText("Could not load this organization."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });
});

describe("the Bring Your Own Keys section", () => {
  it.each(["owner", "admin"] as const)("is an %s's to use", async (role) => {
    mocks.role = role;
    renderShell(<OrganizationProvidersSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("provider-keys")).toHaveTextContent(
        "Elite Law LLP",
      ),
    );
  });

  it("turns a member who follows a link to it away, with a way back", async () => {
    mocks.role = "member";
    const user = userEvent.setup();
    renderShell(<OrganizationProvidersSettings />);

    expect(
      await screen.findByText(
        "Only this organization's owners and admins can manage its keys.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("provider-keys")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to General" }));
    expect(mocks.push).toHaveBeenCalledWith("/organizations/org-1/settings");
  });
});

describe("the settings title", () => {
  it("is a display heading, one step down from the largest", async () => {
    renderShell();
    const title = screen.getByRole("heading", {
      level: 1,
      name: "Organization",
    });
    expect(title).toHaveClass("text-3xl", "font-medium");
    expect(title).not.toHaveClass("text-4xl");
    await screen.findByText("section for Elite Law LLP");
  });
});

describe("an organization's settings belong to its workspace", () => {
  const shell = (
    <OrganizationSettingsProvider orgId="org-1">
      <OrganizationSettingsFrame>
        <Section />
      </OrganizationSettingsFrame>
    </OrganizationSettingsProvider>
  );

  it.each([
    ["another organization's workspace", "org-2"],
    ["the personal workspace", "personal"],
  ])("opened from %s, they switch to their own, and read nothing until then", async (_name, workspaceId) => {
    mocks.workspaceId = workspaceId;
    const view = renderShell();

    // The switch is asked for, with a notice, and nothing is shown or read.
    expect(mocks.setWorkspace).toHaveBeenCalledExactlyOnceWith("org-1");
    expect(mocks.showToast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Switched to Elite Law LLP" }),
    );
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByText(/section for/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Switch to/ }),
    ).not.toBeInTheDocument();
    expect(mocks.getOrg).not.toHaveBeenCalled();

    // The workspace context makes the switch; the settings open.
    mocks.workspaceId = "org-1";
    view.rerender(shell);
    expect(
      await screen.findByText("section for Elite Law LLP"),
    ).toBeInTheDocument();
    expect(mocks.getOrg).toHaveBeenCalledExactlyOnceWith("org-1");
    expect(mocks.setWorkspace).toHaveBeenCalledTimes(1);
  });

  it("switches for a page outside the frame, such as Members, too", () => {
    mocks.workspaceId = "personal";
    render(
      <OrganizationSettingsProvider orgId="org-1">
        <Section />
      </OrganizationSettingsProvider>,
    );
    expect(mocks.setWorkspace).toHaveBeenCalledExactlyOnceWith("org-1");
    expect(screen.queryByText(/section for/)).not.toBeInTheDocument();
    expect(mocks.getOrg).not.toHaveBeenCalled();
  });

  it("lets go when the caller switches away: the switcher takes them home", async () => {
    const view = renderShell();
    await screen.findByText("section for Elite Law LLP");

    mocks.workspaceId = "org-2";
    view.rerender(shell);

    // Nothing of the organization left behind, no pull back to it, and no
    // navigation of its own.
    expect(screen.queryByText(/section for/)).not.toBeInTheDocument();
    expect(mocks.setWorkspace).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("says nothing about an organization the caller does not belong to", async () => {
    const user = userEvent.setup();
    mocks.workspaceId = "org-2";
    mocks.organizations = [
      { id: "org-2", name: "Beta Chambers", role: "member" },
    ];
    renderShell();

    expect(
      screen.getByText("These settings are not available."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Elite Law/)).not.toBeInTheDocument();
    expect(mocks.setWorkspace).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
    expect(mocks.getOrg).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Your organizations" }));
    expect(mocks.push).toHaveBeenCalledWith("/settings/organizations");
  });

  it("waits for the caller's organizations before saying which one this is", () => {
    mocks.workspaceId = "personal";
    mocks.organizations = null;
    const { container } = renderShell();
    expect(container).toBeEmptyDOMElement();
    expect(mocks.getOrg).not.toHaveBeenCalled();
  });

  it("is not narrowed where there is no workspace to compare with", async () => {
    // Outside a WorkspaceProvider nothing is narrowed, as for the lists.
    mocks.workspaceId = null;
    renderShell();
    expect(
      await screen.findByText("section for Elite Law LLP"),
    ).toBeInTheDocument();
  });
});
