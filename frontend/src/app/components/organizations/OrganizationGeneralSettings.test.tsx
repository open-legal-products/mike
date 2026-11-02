import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError, type Org } from "@/app/lib/mikeApi";
import { clearOrganizationLogoCache } from "@/app/hooks/useOrganizationLogo";
import { OrganizationGeneralSettings } from "./OrganizationGeneralSettings";

// The General section of an organization's settings. What this pins:
//
//   - who sees what: everyone the name, their role and the way out; owners
//     and admins the rename; owners alone the delete
//   - the name is an inline field, saved when it is left
//   - carried over from the dialog this replaced: a delete confirmation that
//     closes once the delete succeeds, and a refused delete that is named a
//     failed delete rather than unsaved settings

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  org: null as Org | null,
  setOrg: vi.fn(),
  refreshOrganizations: vi.fn(async () => {}),
  updateOrg: vi.fn(),
  deleteOrg: vi.fn(),
  removeOrgMember: vi.fn(),
  getOrgMemberHandover: vi.fn(),
  listOrgMembers: vi.fn(),
  getOrgLogo: vi.fn(),
  saveOrgLogo: vi.fn(),
  deleteOrgLogo: vi.fn(),
  needsMfaVerification: vi.fn(async () => false),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "me@firm.example" } }),
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ refreshOrganizations: mocks.refreshOrganizations }),
}));
vi.mock("./OrganizationSettingsShell", () => ({
  useOrganizationSettings: () => ({
    orgId: "org-1",
    org: mocks.org,
    setOrg: mocks.setOrg,
    reload: vi.fn(),
  }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  updateOrg: mocks.updateOrg,
  deleteOrg: mocks.deleteOrg,
  removeOrgMember: mocks.removeOrgMember,
  getOrgMemberHandover: mocks.getOrgMemberHandover,
  listOrgMembers: mocks.listOrgMembers,
  getOrgLogo: mocks.getOrgLogo,
  saveOrgLogo: mocks.saveOrgLogo,
  deleteOrgLogo: mocks.deleteOrgLogo,
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
// The framing dialog has its own tests. This stand-in shows what it was
// handed and lets a test save or cancel through it.
vi.mock("./OrganizationLogoModal", () => ({
  OrganizationLogoModal: ({
    file,
    organizationName,
    imageUrl,
    saving,
    onCancel,
    onSave,
    onRemove,
  }: {
    file?: File;
    imageUrl?: string | null;
    onRemove?: () => void;
    organizationName: string;
    saving?: boolean;
    onCancel: () => void;
    onSave: (dataUrl: string) => void;
  }) => (
    <div role="dialog" aria-label="Logo">
      <p>
        {organizationName}|{file?.name ?? imageUrl}|{saving ? "saving" : "idle"}
      </p>
      <button type="button" onClick={() => onSave(FRAMED_LOGO)}>
        Save framed logo
      </button>
      {onRemove ? <button type="button" onClick={onRemove}>Remove logo</button> : null}
      <button type="button" onClick={onCancel}>
        Cancel framing
      </button>
    </div>
  ),
}));

/** What the framing dialog hands back: the logo as it was framed. */
const FRAMED_LOGO = "data:image/png;base64,AAAA";

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
  clearOrganizationLogoCache();
  // Nothing of the caller's to hand over or delete on leaving.
  mocks.getOrgMemberHandover.mockResolvedValue({ projects: [], workflows: [], chats: 0, reviews: 0 });
  mocks.listOrgMembers.mockResolvedValue([]);
  mocks.getOrgLogo.mockResolvedValue(null);
  mocks.org = orgAs("owner");
  // Renaming puts the new organization in place, as the settings area does.
  mocks.setOrg.mockImplementation((next: Org) => {
    mocks.org = next;
  });
});

const nameField = () => screen.getByLabelText("Organization name");

describe("who sees what", () => {
  it("shows an owner the name field, their role, the way out and the delete", () => {
    render(<OrganizationGeneralSettings />);

    expect(nameField()).toHaveValue("Elite Law LLP");
    expect(
      within(screen.getByRole("region", { name: "Your Membership" })).getByText(
        "Owner",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("lets an admin rename the organization but not delete it", () => {
    mocks.org = orgAs("admin");
    render(<OrganizationGeneralSettings />);

    expect(nameField()).toHaveValue("Elite Law LLP");
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Delete Organization" }),
    ).not.toBeInTheDocument();
  });

  it("shows a member the name as text, with nothing to change but their own membership", () => {
    mocks.org = orgAs("member");
    render(<OrganizationGeneralSettings />);

    expect(screen.getByText("Elite Law LLP")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Your Membership" })).getByText(
        "Member",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeEnabled();
  });

  it("offers nothing to press until the organization has loaded", () => {
    mocks.org = null;
    render(<OrganizationGeneralSettings />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });
});

describe("renaming", () => {
  it("saves the name when the field is left, and tells the sidebar", async () => {
    const user = userEvent.setup();
    mocks.updateOrg.mockResolvedValue({
      ...orgAs("owner"),
      name: "Elite Law Group",
    });
    render(<OrganizationGeneralSettings />);

    await user.clear(nameField());
    await user.type(nameField(), "  Elite Law Group ");
    await user.tab();

    await waitFor(() =>
      expect(mocks.updateOrg).toHaveBeenCalledExactlyOnceWith(
        "org-1",
        "Elite Law Group",
      ),
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(mocks.setOrg).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Elite Law Group", member_count: 4 }),
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
  });

  it("saves on Enter too", async () => {
    const user = userEvent.setup();
    mocks.updateOrg.mockResolvedValue({ ...orgAs("owner"), name: "Renamed" });
    render(<OrganizationGeneralSettings />);

    await user.clear(nameField());
    await user.type(nameField(), "Renamed{Enter}");

    await waitFor(() =>
      expect(mocks.updateOrg).toHaveBeenCalledWith("org-1", "Renamed"),
    );
  });

  it("does not save a name that has not changed, or an empty one", async () => {
    const user = userEvent.setup();
    render(<OrganizationGeneralSettings />);

    await user.click(nameField());
    await user.tab();
    await user.clear(nameField());
    await user.tab();

    expect(mocks.updateOrg).not.toHaveBeenCalled();
    // The empty box goes back to the name the organization still has.
    expect(nameField()).toHaveValue("Elite Law LLP");
  });

  it("shows why a rename was refused, beside the field", async () => {
    const user = userEvent.setup();
    mocks.updateOrg.mockRejectedValue(
      new MikeApiError({
        message: "An organization with that name already exists.",
        status: 409,
      }),
    );
    render(<OrganizationGeneralSettings />);

    await user.clear(nameField());
    await user.type(nameField(), "Taken");
    await user.tab();

    expect(
      await screen.findByText("An organization with that name already exists."),
    ).toBeInTheDocument();
    expect(mocks.setOrg).not.toHaveBeenCalled();
    expect(mocks.refreshOrganizations).not.toHaveBeenCalled();
  });
});

describe("leaving", () => {
  it("is a black button, the one action the section offers everyone", () => {
    mocks.org = orgAs("member");
    render(<OrganizationGeneralSettings />);
    const leave = screen.getByRole("button", { name: "Leave" });
    // Same pill as Delete beside it for an owner, set apart by tone.
    expect(leave.className).toMatch(/bg-(black|gray-9\d\d)/);
  });

  it("asks first, then removes the caller and takes them to their organizations", async () => {
    const user = userEvent.setup();
    mocks.org = orgAs("member");
    mocks.removeOrgMember.mockResolvedValue(undefined);
    render(<OrganizationGeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Leave" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Leave");
    expect(dialog.querySelector("header")).toHaveTextContent("Organization›Members›Leave");
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
    // It asks what leaving would hand over and delete before it lets go.
    expect(mocks.getOrgMemberHandover).toHaveBeenCalledWith("org-1", "me");

    const leave = within(dialog).getByRole("button", { name: "Leave" });
    await waitFor(() => expect(leave).toBeEnabled());
    await user.click(leave);

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/settings/organizations"),
    );
    expect(mocks.removeOrgMember).toHaveBeenCalledExactlyOnceWith(
      "org-1",
      "me",
      undefined,
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
  });

  it("says why the last owner cannot leave, and stays put", async () => {
    const user = userEvent.setup();
    mocks.removeOrgMember.mockRejectedValue(
      new MikeApiError({
        message: "An organization must keep at least one owner.",
        status: 409,
      }),
    );
    render(<OrganizationGeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Leave" }));
    const leave = within(await screen.findByRole("dialog")).getByRole(
      "button",
      { name: "Leave" },
    );
    await waitFor(() => expect(leave).toBeEnabled());
    await user.click(leave);

    expect(
      await screen.findByText("Could not leave the organization"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("An organization must keep at least one owner."),
    ).toBeInTheDocument();
    // The dialog that asked is gone; only the refusal is left on screen.
    expect(
      screen.queryByText(
        "You will lose access to this organization's shared resources.",
      ),
    ).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("deleting", () => {
  const confirmDelete = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete Elite Law LLP?")).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
  };

  it("closes the confirmation once the delete succeeds, and leaves", async () => {
    // It was reset on failure and not on success, so after a delete that
    // worked it stayed open over a page navigating away, with a live Delete
    // button aimed at an organization that was gone.
    const user = userEvent.setup();
    mocks.deleteOrg.mockResolvedValue(undefined);
    render(<OrganizationGeneralSettings />);

    await confirmDelete(user);

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/settings/organizations"),
    );
    expect(mocks.deleteOrg).toHaveBeenCalledExactlyOnceWith("org-1");
    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
    // It cannot be fired a second time during the navigation.
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("explains the 30-day owner recovery period before confirming deletion", async () => {
    const user = userEvent.setup();
    render(<OrganizationGeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "removes access to the organization for all members",
    );
    expect(dialog).toHaveTextContent(
      "Its content and memberships are kept for 30 days.",
    );
    expect(dialog).toHaveTextContent("An owner can restore it from Settings → Organizations");
    // Nothing is deleted until it is confirmed.
    expect(mocks.deleteOrg).not.toHaveBeenCalled();
  });

  it("asks for a second factor before deleting, then deletes", async () => {
    const user = userEvent.setup();
    mocks.needsMfaVerification.mockResolvedValueOnce(true);
    mocks.deleteOrg.mockResolvedValue(undefined);
    render(<OrganizationGeneralSettings />);

    await confirmDelete(user);

    await user.click(await screen.findByRole("button", { name: "Verify MFA" }));
    await waitFor(() =>
      expect(mocks.deleteOrg).toHaveBeenCalledExactlyOnceWith("org-1"),
    );
    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith("/settings/organizations"),
    );
  });

  it("names the failure a failed delete, with the server's reason", async () => {
    const user = userEvent.setup();
    mocks.deleteOrg.mockRejectedValue(
      new MikeApiError({
        message: "Only an organization owner can do that.",
        status: 403,
      }),
    );
    render(<OrganizationGeneralSettings />);

    await confirmDelete(user);

    expect(
      await screen.findByText("Organization not deleted"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Only an organization owner can do that."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    // Still theirs to try again.
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("does nothing until the confirmation is answered", async () => {
    const user = userEvent.setup();
    render(<OrganizationGeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );

    expect(mocks.deleteOrg).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete Elite Law LLP?")).not.toBeInTheDocument();
  });
});

describe("the organization's logo", () => {
  const LOGO = "data:image/png;base64,AAAA";
  const picked = new File([new Uint8Array(4)], "logo.png", {
    type: "image/png",
  });
  const pick = (user: ReturnType<typeof userEvent.setup>) =>
    user.upload(screen.getByLabelText("Logo image"), picked);

  it("is the owners' and admins' to set, and not shown to a member", () => {
    mocks.org = orgAs("member");
    const { unmount } = render(<OrganizationGeneralSettings />);
    expect(screen.queryByText("Logo")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Upload logo" }),
    ).not.toBeInTheDocument();
    unmount();

    mocks.org = orgAs("admin");
    render(<OrganizationGeneralSettings />);
    const upload = screen.getByRole("button", { name: "Upload logo" });
    expect(upload).toBeEnabled();
    // The row's one action to take: blue, like the cards' Add and Manage.
    expect(upload.className).toMatch(/bg-blue-/);
    // Nothing to remove until one is set.
    expect(
      screen.queryByRole("button", { name: "Remove logo" }),
    ).not.toBeInTheDocument();
  });

  it("opens the framing dialog for a picked image, and saves nothing until it is framed", async () => {
    const user = userEvent.setup();
    render(<OrganizationGeneralSettings />);

    await pick(user);

    expect(
      within(screen.getByRole("dialog", { name: "Logo" })).getByText(
        "Elite Law LLP|logo.png|idle",
      ),
    ).toBeInTheDocument();
    expect(mocks.saveOrgLogo).not.toHaveBeenCalled();
  });

  it("saves the framed logo, tells the sidebar and closes the dialog", async () => {
    const user = userEvent.setup();
    mocks.saveOrgLogo.mockResolvedValue({
      logo_updated_at: "2026-10-12T10:00:00Z",
    });
    render(<OrganizationGeneralSettings />);

    await pick(user);
    await user.click(screen.getByRole("button", { name: "Save framed logo" }));

    await waitFor(() =>
      expect(mocks.saveOrgLogo).toHaveBeenCalledExactlyOnceWith("org-1", LOGO),
    );
    expect(mocks.setOrg).toHaveBeenCalledWith(
      expect.objectContaining({ logo_updated_at: "2026-10-12T10:00:00Z" }),
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Logo" })).not.toBeInTheDocument(),
    );
  });

  it("changes nothing when the framing is cancelled", async () => {
    const user = userEvent.setup();
    render(<OrganizationGeneralSettings />);

    await pick(user);
    await user.click(screen.getByRole("button", { name: "Cancel framing" }));

    expect(screen.queryByRole("dialog", { name: "Logo" })).not.toBeInTheDocument();
    expect(mocks.saveOrgLogo).not.toHaveBeenCalled();
    expect(mocks.setOrg).not.toHaveBeenCalled();
  });

  it("shows the logo it has and opens it with a blue Edit button", async () => {
    mocks.org = { ...orgAs("owner"), logo_updated_at: "2026-10-12T10:00:00Z" };
    mocks.getOrgLogo.mockResolvedValue(LOGO);
    render(<OrganizationGeneralSettings />);

    expect(await screen.findByAltText("Current logo")).toHaveAttribute(
      "src",
      LOGO,
    );
    const edit = screen.getByRole("button", { name: "Edit logo" });
    expect(edit).toHaveTextContent("Edit");
    expect(edit).toHaveClass("bg-blue-600/90");
    expect(screen.queryByRole("button", { name: "Remove logo" })).not.toBeInTheDocument();
    fireEvent.click(edit);
    expect(screen.getByRole("dialog", { name: "Logo" })).toHaveTextContent(LOGO);
    expect(screen.getByRole("button", { name: "Remove logo" })).toBeEnabled();
  });

  it("removes the logo and tells the sidebar", async () => {
    const user = userEvent.setup();
    mocks.org = { ...orgAs("owner"), logo_updated_at: "2026-10-12T10:00:00Z" };
    mocks.getOrgLogo.mockResolvedValue(LOGO);
    mocks.deleteOrgLogo.mockResolvedValue(undefined);
    render(<OrganizationGeneralSettings />);

    await user.click(screen.getByRole("button", { name: "Edit logo" }));
    await user.click(screen.getByRole("button", { name: "Remove logo" }));

    await waitFor(() =>
      expect(mocks.deleteOrgLogo).toHaveBeenCalledExactlyOnceWith("org-1"),
    );
    expect(mocks.setOrg).toHaveBeenCalledWith(
      expect.objectContaining({ logo_updated_at: null }),
    );
    expect(mocks.refreshOrganizations).toHaveBeenCalledTimes(1);
  });

  it("refuses a file that cannot be a logo before opening the dialog", async () => {
    render(<OrganizationGeneralSettings />);
    // Not a type the picker offers, but a file can still be dropped on it.
    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    fireEvent.change(screen.getByLabelText("Logo image"), {
      target: { files: [svg] },
    });

    expect(await screen.findByText("Logo not updated")).toBeInTheDocument();
    expect(
      screen.getByText("Choose a PNG, JPEG or WebP image."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Logo" })).not.toBeInTheDocument();
    expect(mocks.saveOrgLogo).not.toHaveBeenCalled();
  });

  it("refuses a file over the size limit before opening the dialog", async () => {
    render(<OrganizationGeneralSettings />);
    const huge = new File([new Uint8Array(4)], "logo.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: 10 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("Logo image"), {
      target: { files: [huge] },
    });

    expect(
      await screen.findByText("Choose an image under 10 MB."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Logo" })).not.toBeInTheDocument();
  });

  it("keeps the dialog up when the save is refused, in the server's words, and without them when unexpected", async () => {
    const user = userEvent.setup();
    mocks.saveOrgLogo.mockRejectedValueOnce(
      new MikeApiError({
        message: "The logo is too large. Use an image under 512 KB.",
        status: 400,
      }),
    );
    render(<OrganizationGeneralSettings />);

    await pick(user);
    await user.click(screen.getByRole("button", { name: "Save framed logo" }));
    expect(
      await screen.findByText(
        "The logo is too large. Use an image under 512 KB.",
      ),
    ).toBeInTheDocument();
    // Still there, to try again without framing it over.
    expect(screen.getByRole("dialog", { name: "Logo" })).toBeInTheDocument();

    mocks.saveOrgLogo.mockRejectedValueOnce(new Error("ECONNRESET 10.0.0.4"));
    await user.click(screen.getByRole("button", { name: "Save framed logo" }));
    expect(
      await screen.findByText("The logo could not be saved."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument();
    expect(mocks.setOrg).not.toHaveBeenCalled();
  });
});
