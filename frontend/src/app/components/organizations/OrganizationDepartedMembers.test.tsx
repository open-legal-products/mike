import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MikeApiError,
  type OrgDepartureItem,
  type OrgDepartureList,
  type OrgMember,
} from "@/app/lib/mikeApi";
import { OrganizationDepartedMembers } from "./OrganizationDepartedMembers";

// The Departed view of the Members page: who left, what they left and when
// it is deleted, and handing it on or deleting it — everything, one type of
// work, one item, or a selection.

const mocks = vi.hoisted(() => ({
  listOrgDepartures: vi.fn(),
  reassignOrgDepartureArchives: vi.fn(),
  deleteOrgDepartureArchives: vi.fn(),
  notifySuccess: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  listOrgDepartures: mocks.listOrgDepartures,
  reassignOrgDepartureArchives: mocks.reassignOrgDepartureArchives,
  deleteOrgDepartureArchives: mocks.deleteOrgDepartureArchives,
}));
vi.mock("@/app/lib/userFacingError", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/userFacingError")>()),
  notifySuccess: mocks.notifySuccess,
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
}));

const DAY = 24 * 60 * 60 * 1000;
const inDays = (days: number) =>
  new Date(Date.now() + days * DAY - 60_000).toISOString();

const item = (
  id: string,
  kind: OrgDepartureItem["kind"],
  title: string,
  contents?: OrgDepartureItem["contents"],
): OrgDepartureItem => ({
  id,
  kind,
  item_id: `item-${id}`,
  title,
  archived_at: "2026-10-01T09:00:00Z",
  expires_at: inDays(12),
  ...(contents ? { contents } : {}),
});

const janes = [
  item("p1", "project", "Harbour acquisition", {
    documents: 14,
    chats: 6,
    tabular_reviews: 0,
  }),
  item("p2", "project", "Empty matter", {
    documents: 0,
    chats: 0,
    tabular_reviews: 0,
  }),
  item("c1", "chat", "Limitation periods"),
  item("d1", "document", "Engagement letter.docx"),
];

const listing = (): OrgDepartureList => ({
  truncated: false,
  departures: [
    {
      key: "jane:1",
      member: {
        user_id: "jane",
        display_name: "Jane Lee",
        email: "jane@firm.example",
      },
      departed_at: "2026-10-01T09:00:00Z",
      expires_at: inDays(12),
      items: janes,
    },
    {
      key: "deleted:2",
      member: null,
      departed_at: "2026-10-09T09:00:00Z",
      expires_at: inDays(3),
      items: [item("c9", "chat", "Old notes")],
    },
  ],
});

const members = [
  {
    id: "m1",
    user_id: "me",
    display_name: "William Chen",
    email: "me@firm.example",
    role: "owner",
  },
  {
    id: "m2",
    user_id: "sam",
    display_name: "Sam Park",
    email: "sam@firm.example",
    role: "member",
  },
] as OrgMember[];

const renderView = (search = "") =>
  render(
    <OrganizationDepartedMembers
      orgId="org-1"
      members={members}
      search={search}
      renderToolbar={(actions) => <div data-testid="toolbar">{actions}</div>}
    />,
  );

/** The table row that holds this text. */
const rowOf = (text: string) => {
  const row = screen.getByText(text).closest("div.group");
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${text}`);
  return row;
};

/** Open Jane's row, and then any of her types of work. */
const openJane = async (
  user: ReturnType<typeof userEvent.setup>,
  ...types: string[]
) => {
  await user.click(screen.getByRole("button", { name: "Expand Jane Lee" }));
  for (const type of types)
    await user.click(
      screen.getByRole("button", { name: `Expand Jane Lee's ${type}` }),
    );
};

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mocks.listOrgDepartures.mockImplementation(async () => listing());
  mocks.reassignOrgDepartureArchives.mockResolvedValue({
    resolved: 4,
    unresolved: 0,
  });
  mocks.deleteOrgDepartureArchives.mockResolvedValue({
    resolved: 1,
    unresolved: 0,
  });
});

describe("what it lists", () => {
  it("shows one row per departure with the person, how much they left, when, and the deadline", async () => {
    renderView();

    const jane = within(await waitFor(() => rowOf("Jane Lee")));
    expect(jane.getByText("jane@firm.example")).toBeInTheDocument();
    expect(jane.getByText("4 items")).toBeInTheDocument();
    expect(jane.getByText(/· in 12 days$/)).toBeInTheDocument();
    // How many departures, beside the column's name.
    expect(screen.getByText("Name")).toHaveTextContent("Name (2)");
  });

  it("names a deleted account as a former member, and marks a deadline within a week", async () => {
    renderView();

    const former = within(await waitFor(() => rowOf("Former member")));
    expect(former.getByText("Account deleted")).toBeInTheDocument();
    expect(former.getByText(/· in 3 days$/)).toHaveClass("text-red-600");
    expect(
      within(rowOf("Jane Lee")).getByText(/· in 12 days$/),
    ).not.toHaveClass("text-red-600");
  });

  it("opens a departure into its types of work, and a type into its items", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Jane Lee");

    // Closed to begin with: only the people.
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Expand Former member" }),
    ).toBeInTheDocument();

    // A person opens into their types of work, with how many of each.
    await openJane(user);
    expect(within(rowOf("Projects")).getByText("(2)")).toBeInTheDocument();
    expect(screen.getByText("Library files")).toBeInTheDocument();
    expect(screen.queryByText("Workflows")).not.toBeInTheDocument();
    expect(screen.queryByText("Harbour acquisition")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Expand Jane Lee's projects" }),
    );
    // A project is one line, with what it holds.
    expect(
      within(rowOf("Harbour acquisition")).getByText("14 documents, 6 chats"),
    ).toBeInTheDocument();
    expect(within(rowOf("Empty matter")).getByText("Empty")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse Jane Lee" }));
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByText("Harbour acquisition")).not.toBeInTheDocument();
  });

  it("keeps every checkbox in one column, steps the names in, and gives each type its icon", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Jane Lee");
    await openJane(user, "projects", "library files");

    // No row's cell is padded, so its checkbox sits where the others do.
    for (const name of [
      "Select everything Jane Lee left",
      "Select Jane Lee's projects",
      "Select Harbour acquisition",
    ]) {
      const cell = screen
        .getByRole("checkbox", { name })
        .closest(".table-sticky-cell");
      expect(cell).not.toHaveAttribute("style");
    }
    // The name steps in a level at a time instead.
    expect(screen.getByText("Jane Lee").parentElement).not.toHaveClass("pl-6");
    expect(screen.getByText("Projects").parentElement).toHaveClass("pl-6");
    expect(
      screen.getByText("Harbour acquisition").parentElement,
    ).toHaveClass("pl-12");

    // A type's row, a project and a file each carry an icon before the name.
    for (const text of ["Projects", "Library files", "Harbour acquisition"])
      expect(rowOf(text).querySelector("img")).not.toBeNull();
    expect(
      rowOf("Engagement letter.docx").querySelector("img, svg.lucide"),
    ).not.toBeNull();
  });

  it("narrows to matching people or items, opening what a search found", async () => {
    const view = renderView("limitation");
    expect(await screen.findByText("Limitation periods")).toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByText("Former member")).not.toBeInTheDocument();

    view.rerender(
      <OrganizationDepartedMembers
        orgId="org-1"
        members={members}
        search="nothing like it"
        renderToolbar={() => null}
      />,
    );
    expect(
      screen.getByText(
        "No departed members or archived work match this search.",
      ),
    ).toBeInTheDocument();
  });

  it("says so when nothing is waiting, and when the list could not be read", async () => {
    mocks.listOrgDepartures.mockResolvedValueOnce({
      departures: [],
      truncated: false,
    });
    const view = renderView();
    expect(
      await screen.findByText(/No work is waiting for a decision/),
    ).toBeInTheDocument();
    view.unmount();

    mocks.listOrgDepartures.mockRejectedValueOnce(
      new MikeApiError({ message: "relation boom", status: 500 }),
    );
    const user = userEvent.setup();
    renderView();
    expect(
      await screen.findByText("Could not load departed members."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/relation boom/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Jane Lee")).toBeInTheDocument();
  });
});

describe("reassigning", () => {
  it("hands everything a person left to one member, and says it stays private", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Jane Lee");

    await user.click(
      screen.getByRole("button", { name: "Actions for Jane Lee" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Reassign…" }));

    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByText(/Choose who takes over everything Jane Lee left\./),
    ).toBeInTheDocument();
    expect(
      dialog.getByText(/stays private to its new owner/),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Reassign" }));

    // An owner is offered first.
    await waitFor(() =>
      expect(mocks.reassignOrgDepartureArchives).toHaveBeenCalledWith(
        "org-1",
        ["p1", "p2", "c1", "d1"],
        "me",
      ),
    );
    await waitFor(() =>
      expect(mocks.notifySuccess).toHaveBeenCalledWith(
        "Reassigned to William Chen.",
      ),
    );
    expect(mocks.listOrgDepartures).toHaveBeenCalledTimes(2);
  });

  it("hands over one type of work on its own", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Jane Lee");
    await openJane(user);

    await user.click(
      screen.getByRole("button", { name: "Actions for Jane Lee's projects" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Reassign…" }));
    expect(
      within(screen.getByRole("dialog")).getByText(
        /takes over Jane Lee's 2 projects\./,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Reassign",
      }),
    );
    await waitFor(() =>
      expect(mocks.reassignOrgDepartureArchives).toHaveBeenCalledWith(
        "org-1",
        ["p1", "p2"],
        "me",
      ),
    );
  });

  it("acts on a selection picked across types from the toolbar", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Jane Lee");
    expect(
      within(screen.getByTestId("toolbar")).queryByRole("button"),
    ).not.toBeInTheDocument();

    await openJane(user, "projects");
    await user.click(
      screen.getByRole("checkbox", { name: "Select Harbour acquisition" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Select Jane Lee's chats" }),
    );
    // Part of what she left is selected, not all of it.
    expect(
      screen.getByRole("checkbox", { name: "Select everything Jane Lee left" }),
    ).toHaveProperty("indeterminate", true);

    await user.click(
      within(screen.getByTestId("toolbar")).getByRole("button", {
        name: /Actions/,
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Reassign…" }));
    expect(
      within(screen.getByRole("dialog")).getByText(
        /takes over the 2 selected items\./,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Reassign",
      }),
    );
    await waitFor(() =>
      expect(mocks.reassignOrgDepartureArchives).toHaveBeenCalledWith(
        "org-1",
        ["p1", "c1"],
        "me",
      ),
    );
  });

  it("says how many items could not be reassigned", async () => {
    mocks.reassignOrgDepartureArchives.mockResolvedValue({
      resolved: 3,
      unresolved: 1,
    });
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Jane Lee");

    await user.click(
      screen.getByRole("button", { name: "Actions for Jane Lee" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Reassign…" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Reassign",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "1 item could not be reassigned",
    );
    expect(mocks.notifySuccess).not.toHaveBeenCalled();
  });
});

describe("deleting", () => {
  it("confirms first, naming what goes, then deletes it for good", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Former member");

    await user.click(
      screen.getByRole("button", { name: "Actions for Former member" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByText(
        /Permanently delete everything this former member left, with its contents\?/,
      ),
    ).toBeInTheDocument();
    expect(mocks.deleteOrgDepartureArchives).not.toHaveBeenCalled();

    await user.click(dialog.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mocks.deleteOrgDepartureArchives).toHaveBeenCalledWith("org-1", [
        "c9",
      ]),
    );
    await waitFor(() =>
      expect(mocks.notifySuccess).toHaveBeenCalledWith(
        "Archived work deleted.",
      ),
    );
  });

  it("asks for a second factor when the server requires one, then deletes", async () => {
    mocks.deleteOrgDepartureArchives.mockRejectedValueOnce(
      new MikeApiError({
        message: "MFA verification required",
        status: 403,
        code: "mfa_verification_required",
      }),
    );
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Former member");

    await user.click(
      screen.getByRole("button", { name: "Actions for Former member" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Verify MFA" }));

    await waitFor(() =>
      expect(mocks.deleteOrgDepartureArchives).toHaveBeenCalledTimes(2),
    );
    expect(mocks.notifySuccess).toHaveBeenCalledWith("Archived work deleted.");
  });

  it("reports a failed delete without the server's wording", async () => {
    mocks.deleteOrgDepartureArchives.mockRejectedValueOnce(
      new MikeApiError({ message: "relation boom", status: 500 }),
    );
    const user = userEvent.setup();
    renderView();
    await screen.findByText("Former member");

    await user.click(
      screen.getByRole("button", { name: "Actions for Former member" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not delete this work.",
    );
    expect(screen.queryByText(/relation boom/)).not.toBeInTheDocument();
  });
});
