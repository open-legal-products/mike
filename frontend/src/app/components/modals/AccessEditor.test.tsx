import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
        const props = {
            members: [],
            organizationName: "Elite Law LLP",
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

    it("leaves an empty deny list collapsed and uncounted", () => {
        render(
            <OrganizationAccessEditor
                members={[]}
                assignments={[]}
                onAssign={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        expect(
            screen.getByRole("button", { name: "Deny list" }),
        ).toHaveAttribute("aria-expanded", "false");
    });
});
