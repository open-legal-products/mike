import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OrgMember } from "@/app/lib/mikeApi";
import { MemberDepartureDialog } from "./MemberDepartureDialog";

// What becomes of a member's work when they leave an organization: the
// shared work they alone own goes to one successor; private, unshared work
// is retained for 30 days for organization owners to recover. The dialog says
// so before anything happens, and will not go on without a successor when
// one is needed.

const mocks = vi.hoisted(() => ({
  getOrgMemberHandover: vi.fn(),
  listOrgMembers: vi.fn(),
  removeOrgMember: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrgMemberHandover: mocks.getOrgMemberHandover,
  listOrgMembers: mocks.listOrgMembers,
  removeOrgMember: mocks.removeOrgMember,
}));

const member = (
  user_id: string,
  display_name: string | null,
  role: OrgMember["role"] = "member",
): OrgMember => ({
  id: `m-${user_id}`,
  user_id,
  role,
  display_name,
  email: `${user_id}@firm.example`,
});
const ROSTER = [
  member("dana", "Dana Owner", "owner"),
  member("sam", "Sam Leaver"),
  member("robin", "Robin Heir"),
  member("pat", null),
];
const NOTHING = { sharedChats: 0, sharedReviews: 0, sharedDocuments: 0, projects: [], workflows: [], privateProjects: 0, privateWorkflows: 0, documents: 0, chats: 0, reviews: 0 };
const SAMS_WORK = {
  ...NOTHING,
  projects: [
    { id: "p1", title: "Project Atlas" },
    { id: "p2", title: "" },
  ],
  workflows: [{ id: "w1", title: "Disclosure checklist" }],
  chats: 2,
  reviews: 1,
};

const onCancel = vi.fn();
const onDone = vi.fn();
const renderDialog = (
  props: Partial<Parameters<typeof MemberDepartureDialog>[0]> = {},
) =>
  render(
    <MemberDepartureDialog
      orgId="org-1"
      departing={[ROSTER[1]]}
      members={ROSTER}
      onCancel={onCancel}
      onDone={onDone}
      {...props}
    />,
  );
const confirmButton = (name = "Remove") =>
  within(screen.getByRole("dialog")).getByRole("button", { name });
const chooseSuccessor = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) => {
  await user.click(screen.getByLabelText("Hand over to"));
  await user.click(await screen.findByRole("menuitem", { name }));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrgMemberHandover.mockResolvedValue(NOTHING);
  mocks.listOrgMembers.mockResolvedValue(ROSTER);
  mocks.removeOrgMember.mockResolvedValue(undefined);
});

describe("a member with nothing of their own", () => {
  it("is removed on confirmation, with nobody asked for", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(
      screen.getByText("Sam Leaver will lose organization access."),
    ).toBeInTheDocument();
    // Not before the answer is in: a removal that turned out to need a
    // successor must not have been sent already.
    expect(confirmButton()).toBeDisabled();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    expect(screen.queryByLabelText("Hand over to")).not.toBeInTheDocument();
    expect(screen.queryByText(/permanently deleted/)).not.toBeInTheDocument();

    await user.click(confirmButton());
    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        removedUserIds: ["sam"],
        error: null,
      }),
    );
    expect(mocks.removeOrgMember).toHaveBeenCalledExactlyOnceWith(
      "org-1",
      "sam",
      undefined,
    );
  });
});

describe("a member who alone owns projects and workflows", () => {
  beforeEach(() => {
    mocks.getOrgMemberHandover.mockResolvedValue(SAMS_WORK);
  });

  it("says what has to be handed over and what will be archived", async () => {
    renderDialog();

    expect(
      await screen.findByText("2 projects and 1 workflow need a new owner. Shared and public work will transfer together."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Transfer ownership" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Private work retained for 30 days" }),
    ).toBeVisible();
    const dialog = screen.getByRole("dialog", { name: "Remove" });
    expect(dialog.querySelector("header")).toHaveTextContent(
      "Organization›Members›Remove",
    );
    expect(screen.getByText("Project Atlas")).not.toBeVisible();
    expect(screen.getByText("Disclosure checklist")).toBeInTheDocument();
    // Private shared titles are withheld; counts still include those items.
    expect(screen.queryByText("Untitled")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "2 private chats and 1 tabular review will be archived for 30 days.",
      ),
    ).toBeInTheDocument();
  });

  it("defaults to a remaining organization owner for one bulk handover", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(await screen.findByLabelText("Hand over to")).toHaveTextContent("Dana Owner");
    expect(confirmButton()).toBeEnabled();
    await user.click(confirmButton());
    await waitFor(() => expect(mocks.removeOrgMember).toHaveBeenCalledWith("org-1", "sam", "dana"));
  });

  it("offers the organization's other members, never the one who is going", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(await screen.findByLabelText("Hand over to"));

    const options = (await screen.findAllByRole("menuitem")).map(
      (option) => option.textContent,
    );
    // A member with no name is offered by their address.
    expect(options).toEqual([
      "Dana Owner (dana@firm.example)",
      "Robin Heir (robin@firm.example)",
      "pat@firm.example",
    ]);
  });

  it("hands the work to the chosen member as it removes them", async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByLabelText("Hand over to");

    await chooseSuccessor(user, "Robin Heir (robin@firm.example)");
    // Two members can share a name: the address says which one this is.
    expect(screen.getByLabelText("Hand over to")).toHaveTextContent(
      "Robin Heir (robin@firm.example)",
    );
    await user.click(confirmButton());

    await waitFor(() =>
      expect(mocks.removeOrgMember).toHaveBeenCalledExactlyOnceWith(
        "org-1",
        "sam",
        "robin",
      ),
    );
    expect(onDone).toHaveBeenCalledWith({
      removedUserIds: ["sam"],
      error: null,
    });
  });

  it("reports a removal the server refused, and removes nobody from the page", async () => {
    const user = userEvent.setup();
    const refusal = new Error("An organization must keep at least one owner.");
    mocks.removeOrgMember.mockRejectedValue(refusal);
    renderDialog();
    await screen.findByLabelText("Hand over to");
    await chooseSuccessor(user, "Dana Owner (dana@firm.example)");
    await user.click(confirmButton());

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        removedUserIds: [],
        error: refusal,
      }),
    );
  });

  it("says so when there is nobody to hand it to", async () => {
    renderDialog({ members: [ROSTER[1]] });

    expect(
      await screen.findByText("There is no other member to hand this to."),
    ).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it("keeps multiple items collapsed and lets the user inspect the entire list", async () => {
    const user = userEvent.setup();
    mocks.getOrgMemberHandover.mockResolvedValue({
      ...NOTHING,
      projects: Array.from({ length: 9 }, (_, index) => ({
        id: `p${index}`,
        title: `Matter ${index + 1}`,
      })),
    });
    renderDialog();

    expect(
      await screen.findByText("9 projects need a new owner. Shared and public work will transfer together."),
    ).toBeVisible();
    expect(screen.getByText("Matter 1")).not.toBeVisible();
    expect(screen.getByText("Matter 9")).not.toBeVisible();
    const disclosure = screen.getByText("View items");
    await user.click(disclosure);
    expect(screen.getByText("Matter 1")).toBeVisible();
    expect(screen.getByText("Matter 9")).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(9);
    await user.click(disclosure);
    expect(screen.getByText("Matter 9")).not.toBeVisible();
    expect(confirmButton()).toBeEnabled();
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
  });
});

describe("leaving", () => {
  it("speaks to the member, and lets them name their own successor", async () => {
    const user = userEvent.setup();
    mocks.getOrgMemberHandover.mockResolvedValue({
      ...NOTHING,
      workflows: [{ id: "w1", title: "Disclosure checklist" }],
      chats: 1,
    });
    // Opened from settings, which has no roster of its own to pass.
    renderDialog({ leaving: true, members: undefined });

    expect(
      screen.getByText(
        "You will lose access to this organization's shared resources.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("1 workflow needs a new owner. Shared and public work will transfer together."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 private chat will be archived for 30 days."),
    ).toBeInTheDocument();
    expect(screen.getByText("Disclosure checklist")).toBeVisible();
    expect(screen.queryByText("View items")).not.toBeInTheDocument();
    expect(mocks.listOrgMembers).toHaveBeenCalledWith("org-1");

    await chooseSuccessor(user, "Dana Owner (dana@firm.example)");
    await user.click(confirmButton("Leave"));
    await waitFor(() =>
      expect(mocks.removeOrgMember).toHaveBeenCalledWith(
        "org-1",
        "sam",
        "dana",
      ),
    );
  });
});

describe("removing several members together", () => {
  it("hands all of their work to one successor, who is none of them", async () => {
    const user = userEvent.setup();
    mocks.getOrgMemberHandover.mockResolvedValue({
      ...NOTHING,
      projects: [{ id: "p1", title: "Project Atlas" }],
      workflows: [{ id: "w1", title: "Checklist" }],
    });
    renderDialog({ departing: [ROSTER[1], ROSTER[2]] });

    expect(
      screen.getByText(
        "2 selected members will lose access to this organization.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("1 project and 1 workflow need a new owner. Shared and public work will transfer together."),
    ).toBeInTheDocument();
    expect(mocks.getOrgMemberHandover).toHaveBeenCalledWith("org-1", "sam", ["sam", "robin"]);
    await user.click(screen.getByLabelText("Hand over to"));
    expect(
      (await screen.findAllByRole("menuitem")).map((o) => o.textContent),
    ).toEqual(["Dana Owner (dana@firm.example)", "pat@firm.example"]);
    await user.click(
      screen.getByRole("menuitem", { name: "Dana Owner (dana@firm.example)" }),
    );
    await user.click(confirmButton());

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocks.removeOrgMember.mock.calls).toEqual([
      ["org-1", "sam", "dana"],
      ["org-1", "robin", "dana"],
    ]);
  });

  it("reports who went and the first refusal when only some could be removed", async () => {
    const user = userEvent.setup();
    const refusal = new Error("Only an organization owner can do that.");
    mocks.removeOrgMember.mockImplementation(
      async (_orgId: string, userId: string) => {
        if (userId === "robin") throw refusal;
      },
    );
    renderDialog({ departing: [ROSTER[1], ROSTER[2]] });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    await user.click(confirmButton());

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith({
        removedUserIds: ["sam"],
        error: refusal,
      }),
    );
  });
});

describe("when what would be handed over cannot be read", () => {
  it("says so and removes nobody", async () => {
    const user = userEvent.setup();
    mocks.getOrgMemberHandover.mockRejectedValue(new Error("offline"));
    renderDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not check what would be transferred or archived.",
    );
    expect(confirmButton()).toBeDisabled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(onCancel).toHaveBeenCalled();
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
  });
});

describe("private work without another owner", () => {
  it("shows archive counts without a transfer selector or private titles", async () => {
    const user = userEvent.setup();
    mocks.getOrgMemberHandover.mockResolvedValue({
      ...NOTHING, privateProjects: 2, privateWorkflows: 1, documents: 3,
    });
    renderDialog();
    expect(await screen.findByText(
      "2 private projects, 1 private workflow and 3 documents will be archived for 30 days.",
    )).toBeVisible();
    expect(screen.getByText(/Only organization owners can recover, reassign or delete this work/)).toBeVisible();
    expect(screen.queryByLabelText("Hand over to")).not.toBeInTheDocument();
    expect(screen.queryByText("View items")).not.toBeInTheDocument();
    await user.click(confirmButton());
    expect(mocks.removeOrgMember).toHaveBeenCalledWith("org-1", "sam", undefined);
  });
});
