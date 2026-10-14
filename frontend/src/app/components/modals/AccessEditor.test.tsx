import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    AccessEditor,
    OrganizationAccessEditor,
    type AccessRow,
} from "./AccessEditor";

const ROWS: AccessRow[] = [
    {
        key: "me",
        user_id: "user-me",
        email: "me@firm.example",
        display_name: "Me",
        role: "owner",
    },
    {
        key: "other",
        user_id: "user-other",
        email: "other@firm.example",
        display_name: "Other Counsel",
        role: "viewer",
    },
];

function renderEditor(
    overrides: Partial<ComponentProps<typeof AccessEditor>> = {},
) {
    return render(
        <AccessEditor
            scope="direct"
            rows={ROWS}
            canManage
            newRole="editor"
            onNewRoleChange={vi.fn()}
            onAdd={vi.fn()}
            onRoleChange={vi.fn()}
            onRemove={vi.fn()}
            {...overrides}
        />,
    );
}

describe("AccessEditor — the viewer's own grant", () => {
    it("renders your own row read-only while leaving other rows editable", () => {
        // Removing yourself is one unconfirmed click away from locking
        // yourself out, and re-roling yourself is refused by the server.
        renderEditor({ currentUserEmail: "  Me@Firm.Example  " });

        expect(screen.getByText("You")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Role for me@firm.example" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: "Actions for me@firm.example",
            }),
        ).not.toBeInTheDocument();

        const ownRow = screen
            .getByText("me@firm.example")
            .closest<HTMLElement>('[role="listitem"]');
        expect(within(ownRow!).getByText("Owner")).toBeInTheDocument();

        expect(
            screen.getByRole("button", { name: "Role for other@firm.example" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: "Actions for other@firm.example",
            }),
        ).toBeInTheDocument();
    });

    it("recognises your row by user id when no email is threaded through", () => {
        renderEditor({ currentUserId: "user-me" });

        expect(screen.getByText("You")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Role for me@firm.example" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: "Actions for me@firm.example",
            }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Role for other@firm.example" }),
        ).toBeInTheDocument();
    });

    it("leaves every row interactive when the viewer cannot be identified", () => {
        renderEditor();

        expect(screen.queryByText("You")).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Role for me@firm.example" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Actions for me@firm.example" }),
        ).toBeInTheDocument();
    });
});

describe("AccessEditor — failures and empty states", () => {
    it("shows the error to somebody who cannot manage access", () => {
        // The message used to live inside the add form, which is only
        // rendered to a manager in the direct scope, so a failed revoke or
        // re-role anywhere else was silent.
        renderEditor({
            canManage: false,
            onAdd: undefined,
            error: "Could not remove access.",
        });

        expect(screen.getByRole("alert")).toHaveTextContent(
            "Could not remove access.",
        );
    });

    it("does not claim nobody has access when access is inherited", () => {
        renderEditor({ scope: "project", rows: [], canManage: false });

        expect(
            screen.getByText(/Access is inherited from the project/),
        ).toBeInTheDocument();
        expect(
            screen.queryByText("No one has access yet."),
        ).not.toBeInTheDocument();
    });
});

describe("OrganizationAccessEditor — deny list", () => {
    it("opens the deny list, with its count, once the roster loads", () => {
        // A wall only means something on a public item, so that is where
        // the deny list lives.
        const props = {
            members: [],
            organizationName: "Elite Law LLP",
            visibility: "organization" as const,
            onAssign: vi.fn(),
            onRemove: vi.fn(),
        };
        const { rerender } = render(
            <OrganizationAccessEditor {...props} assignments={[]} loading />,
        );

        expect(
            screen.getByRole("button", { name: "Deny list" }),
        ).toHaveAttribute("aria-expanded", "false");

        // Assignments arrive with the roster, after mount, so a plain
        // useState initialiser would never see them.
        rerender(
            <OrganizationAccessEditor
                {...props}
                loading={false}
                assignments={[
                    {
                        key: "denied-1",
                        user_id: "denied-1",
                        email: "walled@firm.example",
                        display_name: "Walled Off",
                        role: "deny",
                    },
                    {
                        key: "denied-2",
                        user_id: "denied-2",
                        email: "conflicted@firm.example",
                        display_name: "Conflicted",
                        role: "deny",
                    },
                ]}
            />,
        );

        const toggle = screen.getByRole("button", { name: "Deny list (2)" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        const denyList = screen.getByRole("list", { name: "Deny list entries" });
        expect(
            within(denyList).getByText("walled@firm.example"),
        ).toBeInTheDocument();
        expect(
            within(denyList).getByText("conflicted@firm.example"),
        ).toBeInTheDocument();
    });

    it("stays collapsed after the reader closes it and the roster reloads", () => {
        // Every grant and revoke re-reads the roster, and each re-read used to
        // re-run the auto-expand: a deny list the reader had deliberately
        // collapsed sprang open again after their next change.
        const assignments = [
            {
                key: "denied-1",
                user_id: "denied-1",
                email: "walled@firm.example",
                display_name: "Walled Off",
                role: "deny" as const,
            },
        ];
        const props = {
            members: [],
            assignments,
            organizationName: "Elite Law LLP",
            onAssign: vi.fn(),
            onRemove: vi.fn(),
        };
        const { rerender } = render(
            <OrganizationAccessEditor {...props} loading />,
        );
        rerender(<OrganizationAccessEditor {...props} loading={false} />);

        const toggle = screen.getByRole("button", { name: "Deny list (1)" });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        fireEvent.click(toggle);
        expect(
            screen.getByRole("button", { name: "Deny list (1)" }),
        ).toHaveAttribute("aria-expanded", "false");

        // A refetch: loading goes back up and settles again.
        rerender(<OrganizationAccessEditor {...props} loading />);
        rerender(<OrganizationAccessEditor {...props} loading={false} />);

        expect(
            screen.getByRole("button", { name: "Deny list (1)" }),
        ).toHaveAttribute("aria-expanded", "false");
    });

    it("keeps the caller out of the pickers", () => {
        // The server refuses any grant aimed at the caller ("You cannot
        // share a project with yourself"), so their own name in these pickers
        // was an action that could only fail.
        render(
            <OrganizationAccessEditor
                members={[
                    {
                        key: "me",
                        user_id: "user-me",
                        email: "me@firm.example",
                        display_name: "Me",
                        role: "editor",
                    },
                    {
                        key: "other",
                        user_id: "user-other",
                        email: "other@firm.example",
                        display_name: "Other Counsel",
                        role: "editor",
                    },
                ]}
                assignments={[]}
                currentUserId="user-me"
                currentUserEmail="me@firm.example"
                onAssign={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        const ownerSearch = screen.getByRole("searchbox", { name: "People" });
        fireEvent.focus(ownerSearch);
        fireEvent.change(ownerSearch, { target: { value: "firm.example" } });
        const ownerMatches = screen.getByRole("listbox", {
            name: "People matches",
        });
        expect(
            within(ownerMatches).getByText("Other Counsel"),
        ).toBeInTheDocument();
        expect(within(ownerMatches).queryByText("Me")).not.toBeInTheDocument();
    });

    it("leaves an empty deny list collapsed and uncounted", () => {
        render(
            <OrganizationAccessEditor
                members={[]}
                assignments={[]}
                visibility="organization"
                onAssign={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("button", { name: "Deny list" }),
        ).toHaveAttribute("aria-expanded", "false");
    });
});

// Whether an item is public or private is set with its details. The editor is
// what follows: the individuals a private item is shared with, or — for a
// public one, which everybody can already open and edit — who else owns it
// and who is walled off.
describe("OrganizationAccessEditor — public and private", () => {
    const MEMBERS = [
        {
            key: "me",
            user_id: "user-me",
            email: "me@firm.example",
            display_name: "Me",
            role: "editor" as const,
        },
        {
            key: "boss",
            user_id: "user-boss",
            email: "boss@firm.example",
            display_name: "Org Owner",
            // One of the organization's owners.
            role: "owner" as const,
        },
        {
            key: "jane",
            user_id: "user-jane",
            email: "jane@firm.example",
            display_name: "Jane Lee",
            role: "editor" as const,
        },
        {
            key: "sam",
            user_id: "user-sam",
            email: "sam@firm.example",
            display_name: "Sam Shared",
            role: "editor" as const,
        },
    ];
    const SHARED = {
        key: "sam",
        user_id: "user-sam",
        email: "sam@firm.example",
        display_name: "Sam Shared",
        role: "viewer" as const,
    };
    const renderEditor = (
        props: Partial<Parameters<typeof OrganizationAccessEditor>[0]> = {},
    ) => {
        const handlers = { onAssign: vi.fn(), onRemove: vi.fn() };
        render(
            <OrganizationAccessEditor
                members={MEMBERS}
                assignments={[SHARED]}
                organizationName="Elite Law LLP"
                currentUserId="user-me"
                currentUserEmail="me@firm.example"
                {...handlers}
                {...props}
            />,
        );
        return handlers;
    };
    const searchPeople = (text: string) => {
        const search = screen.getByRole("searchbox", { name: "People" });
        fireEvent.focus(search);
        fireEvent.change(search, { target: { value: text } });
        return screen.getByRole("listbox", { name: "People matches" });
    };

    it("neither holds nor announces the setting: that lives with the item's details", () => {
        const { unmount } = render(
            <OrganizationAccessEditor
                members={MEMBERS}
                assignments={[SHARED]}
                organizationName="Elite Law LLP"
                onAssign={vi.fn()}
                onRemove={vi.fn()}
            />,
        );
        expect(screen.queryByRole("switch")).not.toBeInTheDocument();
        expect(screen.queryByText("Private")).not.toBeInTheDocument();
        unmount();

        renderEditor({ visibility: "organization" });
        expect(screen.queryByRole("switch")).not.toBeInTheDocument();
        expect(screen.queryByText("Public")).not.toBeInTheDocument();
    });

    it("offers a private item a people picker, and no deny list", () => {
        renderEditor();
        expect(
            screen.getByRole("searchbox", { name: "People" }),
        ).toBeInTheDocument();
        // No wall to build on an item nobody was let into.
        expect(
            screen.queryByRole("button", { name: /^Deny list/ }),
        ).not.toBeInTheDocument();
    });

    it("lets more owners be added to a public item, which everyone can already open", () => {
        const { onAssign } = renderEditor({
            visibility: "organization",
            assignments: [],
        });
        // Ownership is the only standing left to hand out, so there is no
        // role to choose and no general people picker.
        expect(
            screen.queryByRole("searchbox", { name: "People" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: /^Role for the next person added/,
            }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByText(
                "Add Elite Law LLP members as owners with rights to manage access, settings and delete the project. Everyone in Elite Law LLP can already open and edit it.",
            ),
        ).toBeInTheDocument();

        const owners = screen.getByRole("searchbox", {
            name: "Project owners",
        });
        fireEvent.focus(owners);
        fireEvent.change(owners, { target: { value: "jane" } });
        fireEvent.click(
            within(
                screen.getByRole("listbox", { name: "Project owners matches" }),
            ).getByText("Jane Lee"),
        );
        expect(onAssign).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: "user-jane" }),
            "owner",
        );
        expect(
            screen.getByText("No additional Owners added."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Deny list" }),
        ).toBeInTheDocument();
    });

    it("names a workflow's owners on a public workflow", () => {
        renderEditor({
            visibility: "organization",
            ownerLabel: "Workflow owners",
            assignments: [],
        });
        expect(
            screen.getByRole("searchbox", { name: "Workflow owners" }),
        ).toBeInTheDocument();
    });

    it("lists a public item's creator, added owners and anyone holding another role", async () => {
        // Somebody it was shared with while private keeps the role they were
        // given. Hiding that would hide who is a Viewer.
        const user = userEvent.setup();
        const { onRemove } = renderEditor({
            visibility: "organization",
            assignments: [
                {
                    key: "creator",
                    user_id: "user-me",
                    email: "me@firm.example",
                    display_name: "Me",
                    role: "owner",
                    isCreator: true,
                },
                SHARED,
            ],
        });
        const list = screen.getByRole("list", { name: "Project owners list" });
        expect(within(list).getByText("me@firm.example")).toBeInTheDocument();
        // The creator is always an Owner: nothing to change or remove.
        expect(
            within(list).queryByRole("button", {
                name: "Actions for me@firm.example",
            }),
        ).not.toBeInTheDocument();
        expect(within(list).getByText("sam@firm.example")).toBeInTheDocument();
        expect(
            within(list).getByRole("button", {
                name: "Role for sam@firm.example",
            }),
        ).toHaveTextContent("Viewer");

        await user.click(
            within(list).getByRole("button", {
                name: "Actions for sam@firm.example",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Remove" }));
        expect(onRemove).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: "user-sam" }),
        );
    });

    it("shows an owner on a public item as a name, an email and a Remove menu, with no role pill", async () => {
        const user = userEvent.setup();
        const { onRemove } = renderEditor({
            visibility: "organization",
            assignments: [
                {
                    key: "creator",
                    user_id: "user-me",
                    email: "me@firm.example",
                    display_name: "Me",
                    role: "owner",
                    isCreator: true,
                },
                {
                    key: "jane",
                    user_id: "user-jane",
                    email: "jane@firm.example",
                    display_name: "Jane Lee",
                    role: "owner",
                },
            ],
        });
        const list = screen.getByRole("list", { name: "Project owners list" });
        // The heading already says these are owners.
        expect(within(list).queryByText("Owner")).not.toBeInTheDocument();
        expect(
            within(list).queryByRole("button", { name: /^Role for/ }),
        ).not.toBeInTheDocument();

        const row = within(list)
            .getByText("Jane Lee")
            .closest("li") as HTMLElement;
        // Email at the right end, then the menu.
        expect(within(row).getByText("jane@firm.example")).toHaveClass(
            "sm:justify-self-end",
        );
        expect(row.lastElementChild).toHaveAccessibleName(
            "Actions for jane@firm.example",
        );
        expect(row.children).toHaveLength(3);

        await user.click(
            within(row).getByRole("button", {
                name: "Actions for jane@firm.example",
            }),
        );
        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent),
        ).toEqual(["Remove"]);
        await user.click(screen.getByRole("menuitem", { name: "Remove" }));
        expect(onRemove).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: "user-jane" }),
        );
    });

    it("still shows the role of somebody on a public item's list who is not an owner", () => {
        // Without it a Viewer would pass for an owner under that heading.
        renderEditor({ visibility: "organization" });
        const list = screen.getByRole("list", { name: "Project owners list" });
        expect(
            within(list).getByRole("button", {
                name: "Role for sam@firm.example",
            }),
        ).toHaveTextContent("Viewer");
    });

    it("still lists the creator, as Owner, on a private item", () => {
        renderEditor({
            assignments: [
                {
                    key: "creator",
                    user_id: "user-me",
                    email: "me@firm.example",
                    display_name: "Me",
                    role: "owner",
                    isCreator: true,
                },
            ],
        });
        const list = screen.getByRole("list", { name: "People with access" });
        expect(within(list).getByText("me@firm.example")).toBeInTheDocument();
        expect(within(list).getByText("Owner")).toBeInTheDocument();
    });

    it("keeps showing an existing deny list on a private item", () => {
        // Making it public again must not be a surprise.
        renderEditor({
            assignments: [
                SHARED,
                {
                    key: "jane",
                    user_id: "user-jane",
                    email: "jane@firm.example",
                    display_name: "Jane Lee",
                    role: "deny",
                },
            ],
        });
        expect(
            screen.getByRole("button", { name: "Deny list (1)" }),
        ).toBeInTheDocument();
    });

    it("adds a member to a private item as an Editor, with no role to choose first", () => {
        const { onAssign } = renderEditor();
        // The role is set in the person's row afterwards, not beside the
        // search field.
        expect(
            screen.queryByRole("button", {
                name: /^Role for the next person added/,
            }),
        ).not.toBeInTheDocument();

        fireEvent.click(within(searchPeople("jane")).getByText("Jane Lee"));
        expect(onAssign).toHaveBeenCalledTimes(1);
        expect(onAssign).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: "user-jane" }),
            "editor",
        );
    });

    it("tells the person adding people where the role is changed", () => {
        renderEditor();
        expect(
            screen.getByText(
                "Share this project with members of Elite Law LLP. They are added as Editors; change a person's role in the list below. It cannot be shared outside the organisation.",
            ),
        ).toBeInTheDocument();
    });

    it("offers only members who can still be added", () => {
        renderEditor();
        const matches = searchPeople("firm.example");
        // Not the caller, and not somebody it is already shared with.
        expect(within(matches).getByText("Jane Lee")).toBeInTheDocument();
        expect(within(matches).queryByText("Me")).not.toBeInTheDocument();
        expect(within(matches).queryByText("Sam Shared")).not.toBeInTheDocument();
    });

    it("offers the organization's owner on a private item, like any other member", () => {
        // A private item is not theirs by office: unless it is shared with
        // them they cannot open it, so they have to be nameable here.
        const { onAssign } = renderEditor();
        const matches = searchPeople("boss");
        fireEvent.click(within(matches).getByText("Org Owner"));
        expect(onAssign).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: "user-boss" }),
            "editor",
        );
    });

    it("does not offer the organization's owner on a public item, which they own already", () => {
        renderEditor({ visibility: "organization", assignments: [] });
        const owners = screen.getByRole("searchbox", {
            name: "Project owners",
        });
        fireEvent.focus(owners);
        fireEvent.change(owners, { target: { value: "firm.example" } });
        const matches = screen.getByRole("listbox", {
            name: "Project owners matches",
        });
        expect(within(matches).getByText("Jane Lee")).toBeInTheDocument();
        expect(within(matches).queryByText("Org Owner")).not.toBeInTheDocument();
    });

    it("lists the people it is shared with, each at their role, and changes or removes them", async () => {
        const user = userEvent.setup();
        const { onAssign, onRemove } = renderEditor();
        const list = screen.getByRole("list", { name: "People with access" });
        expect(within(list).getByText("sam@firm.example")).toBeInTheDocument();

        await user.click(
            within(list).getByRole("button", {
                name: "Role for sam@firm.example",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Owner" }));
        expect(onAssign).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: "user-sam" }),
            "owner",
        );

        await user.click(
            within(list).getByRole("button", {
                name: "Actions for sam@firm.example",
            }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Remove" }));
        expect(onRemove).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: "user-sam" }),
        );
    });

    it("lets somebody who cannot change access see it without controls", () => {
        renderEditor({ disabled: true });
        expect(screen.getByRole("searchbox", { name: "People" })).toBeDisabled();
        const list = screen.getByRole("list", { name: "People with access" });
        expect(within(list).getByText("Viewer")).toBeInTheDocument();
        expect(within(list).queryByRole("button")).not.toBeInTheDocument();
    });

    it("says so when a private item has not been shared yet", () => {
        renderEditor({ assignments: [] });
        expect(
            screen.getByText("Not shared with anyone yet."),
        ).toBeInTheDocument();
    });
});
