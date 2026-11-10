import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError, type Org } from "@/app/lib/mikeApi";
import { OrganizationPrivacyData } from "./OrganizationPrivacyData";

// The Privacy & Data section of an organization's settings. What this pins:
//
//   - it is an owner's alone; anyone else is told why and shown the way back
//   - each delete names what goes, for every member, and suggests exporting
//   - nothing is deleted until it is confirmed, and a sensitive action asks
//     for a second factor first

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  org: null as Org | null,
  deleteOrgData: vi.fn(),
  needsMfaVerification: vi.fn(async () => false),
  loadChats: vi.fn(async () => {}),
  setCurrentChatId: vi.fn(),
  setOrg: vi.fn(),
  refreshOrganizations: vi.fn(async () => {}),
  setOrgMemberDataPolicy: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    loadChats: mocks.loadChats,
    setCurrentChatId: mocks.setCurrentChatId,
  }),
}));
vi.mock("./OrganizationSettingsShell", () => ({
  organizationSettingsHref: (orgId: string, section?: string) =>
    `/organizations/${orgId}/settings${section ? `/${section}` : ""}`,
  useOrganizationSettings: () => ({
    orgId: "org-1",
    org: mocks.org,
    setOrg: mocks.setOrg,
  }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ refreshOrganizations: mocks.refreshOrganizations }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  deleteOrgData: mocks.deleteOrgData,
  setOrgMemberDataPolicy: mocks.setOrgMemberDataPolicy,
}));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
  MfaVerificationPopup: ({
    open,
    onVerified,
  }: {
    open: boolean;
    onVerified: () => void;
  }) =>
    open ? (
      <button type="button" onClick={onVerified}>
        Verify MFA
      </button>
    ) : null,
  needsMfaVerification: mocks.needsMfaVerification,
}));

const orgAs = (role: Org["role"]): Org =>
  ({
    id: "org-1",
    name: "Elite Law LLP",
    created_by: "someone",
    role,
    member_count: 4,
  }) as Org;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.org = orgAs("owner");
  mocks.deleteOrgData.mockResolvedValue(undefined);
});

const confirmDelete = async (
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) => {
  await user.click(screen.getByRole("button", { name: label }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }),
  );
};

describe("who may use it", () => {
  it("offers an owner every delete", () => {
    render(<OrganizationPrivacyData />);
    for (const label of [
      "Delete all chats",
      "Delete all tabular reviews",
      "Delete all projects",
      "Delete all playbooks",
      "Delete all memory",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeEnabled();
    }
  });

  it.each(["admin", "member"] as const)(
    "turns an %s away, with a way back",
    async (role) => {
      mocks.org = orgAs(role);
      const user = userEvent.setup();
      render(<OrganizationPrivacyData />);

      expect(
        screen.getByText("Only this organization's owners can manage its data."),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Delete all projects" }),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Back to General" }));
      expect(mocks.push).toHaveBeenCalledWith("/organizations/org-1/settings");
    },
  );

  it("leads an owner to the departed members' work on the Members page", async () => {
    const user = userEvent.setup();
    render(<OrganizationPrivacyData />);

    await user.click(
      screen.getByRole("button", { name: "Review departed members" }),
    );
    expect(mocks.push).toHaveBeenCalledWith(
      "/organizations/org-1/settings/members?view=departed",
    );
  });

  it("keeps the deletes disabled until the caller's role is known", () => {
    mocks.org = null;
    render(<OrganizationPrivacyData />);
    expect(
      screen.getByRole("button", { name: "Delete all projects" }),
    ).toBeDisabled();
  });
});

describe("deleting organization data", () => {
  it.each([
    ["Delete all chats", "chats"],
    ["Delete all tabular reviews", "tabular-reviews"],
    ["Delete all projects", "projects"],
    ["Delete all playbooks", "playbooks"],
    ["Delete all memory", "memories"],
  ])("%s deletes that kind once confirmed", async (label, kind) => {
    const user = userEvent.setup();
    render(<OrganizationPrivacyData />);

    await user.click(screen.getByRole("button", { name: label }));
    expect(mocks.deleteOrgData).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "This action cannot be undone.",
    );

    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(mocks.deleteOrgData).toHaveBeenCalledExactlyOnceWith("org-1", kind),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("says the delete reaches every member and suggests exporting first", async () => {
    const user = userEvent.setup();
    render(<OrganizationPrivacyData />);

    await user.click(screen.getByRole("button", { name: "Delete all projects" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("for every member");
    expect(dialog).toHaveTextContent(
      "Consider exporting anything you need to keep first.",
    );
  });

  it("reloads chat history after chats are deleted", async () => {
    const user = userEvent.setup();
    render(<OrganizationPrivacyData />);

    await confirmDelete(user, "Delete all chats");

    await waitFor(() => expect(mocks.loadChats).toHaveBeenCalledTimes(1));
    expect(mocks.setCurrentChatId).toHaveBeenCalledWith(null);
  });

  it("asks for a second factor first, then deletes", async () => {
    const user = userEvent.setup();
    mocks.needsMfaVerification.mockResolvedValueOnce(true);
    render(<OrganizationPrivacyData />);

    await confirmDelete(user, "Delete all projects");
    expect(mocks.deleteOrgData).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Verify MFA" }));
    await waitFor(() =>
      expect(mocks.deleteOrgData).toHaveBeenCalledExactlyOnceWith(
        "org-1",
        "projects",
      ),
    );
  });

  it("reports a failed delete without the server's wording", async () => {
    const user = userEvent.setup();
    mocks.deleteOrgData.mockRejectedValue(
      new MikeApiError({ message: "relation boom", status: 500 }),
    );
    render(<OrganizationPrivacyData />);

    await confirmDelete(user, "Delete all tabular reviews");

    expect(
      await screen.findByText("Failed to delete data. Please try again."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/relation boom/)).not.toBeInTheDocument();
  });
});

// Whether members may export, and bulk-delete, their own work: off until an
// owner allows it.
describe("OrganizationPrivacyData member data policy", () => {
  it("starts with both off", () => {
    render(<OrganizationPrivacyData />);

    expect(
      screen.getByRole("switch", { name: "Let members export their data" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByRole("switch", { name: "Let members delete their data in bulk" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("saves one change, keeping the other setting, and refreshes the organizations", async () => {
    const user = userEvent.setup();
    mocks.org = { ...orgAs("owner"), allow_member_deletes: true };
    mocks.setOrgMemberDataPolicy.mockResolvedValue({
      allow_member_exports: true,
      allow_member_deletes: true,
    });
    render(<OrganizationPrivacyData />);

    await user.click(
      screen.getByRole("switch", { name: "Let members export their data" }),
    );

    await waitFor(() =>
      expect(mocks.setOrgMemberDataPolicy).toHaveBeenCalledWith("org-1", {
        allow_member_exports: true,
        allow_member_deletes: true,
      }),
    );
    expect(mocks.setOrg).toHaveBeenCalledWith(
      expect.objectContaining({ allow_member_exports: true }),
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalled();
  });

  it("asks for a second factor and then sends the same change again", async () => {
    const user = userEvent.setup();
    mocks.setOrgMemberDataPolicy
      .mockRejectedValueOnce(
        new MikeApiError({
          message: "MFA required",
          status: 403,
          code: "mfa_verification_required",
        }),
      )
      .mockResolvedValueOnce({
        allow_member_exports: false,
        allow_member_deletes: true,
      });
    render(<OrganizationPrivacyData />);

    await user.click(
      screen.getByRole("switch", { name: "Let members delete their data in bulk" }),
    );
    await user.click(await screen.findByRole("button", { name: "Verify MFA" }));

    await waitFor(() =>
      expect(mocks.setOrgMemberDataPolicy).toHaveBeenCalledTimes(2),
    );
    expect(mocks.setOrgMemberDataPolicy).toHaveBeenLastCalledWith("org-1", {
      allow_member_exports: false,
      allow_member_deletes: true,
    });
  });

  it("is not shown to an admin", () => {
    mocks.org = orgAs("admin");
    render(<OrganizationPrivacyData />);
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
