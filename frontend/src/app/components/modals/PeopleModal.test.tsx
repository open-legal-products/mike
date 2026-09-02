import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError } from "@/app/lib/mikeApi";
import { PeopleModal } from "./PeopleModal";

// `importOriginal` keeps the real `MikeApiError` class: `userFacingApiError`
// decides with `instanceof`, so a stand-in class would make every 4xx look
// like an unexpected failure and the tests below would pass vacuously.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    lookupUserByEmail: vi.fn().mockResolvedValue({
        exists: true,
        email: "known@firm.example",
        display_name: "Known",
    }),
}));

const PROJECT = {
    id: "p1",
    shared_with: ["counsel@outside.example"],
    owner_email: "creator@firm.example",
    owner_display_name: "Creator",
};

function peopleResponse() {
    return Promise.resolve({
        owner: {
            user_id: "u1",
            email: "creator@firm.example",
            display_name: "Creator",
            role: "admin" as const,
        },
        members: [
            {
                email: "counsel@outside.example",
                display_name: null,
                role: "viewer" as const,
            },
        ],
    });
}

function renderRoleAware(overrides?: {
    canManage?: boolean;
    orgId?: string | null;
    onGrant?: (email: string, role: string) => Promise<void>;
    onRevoke?: (email: string) => Promise<void>;
}) {
    const onGrant = overrides?.onGrant ?? vi.fn().mockResolvedValue(undefined);
    const onRevoke =
        overrides?.onRevoke ?? vi.fn().mockResolvedValue(undefined);
    render(
        <PeopleModal
            open
            onClose={vi.fn()}
            resource={PROJECT}
            fetchPeople={peopleResponse}
            currentUserEmail="me@firm.example"
            breadcrumb={["Projects", "Matter", "People"]}
            access={{
                grants: [
                    { email: "counsel@outside.example", role: "viewer" },
                ],
                orgId: overrides?.orgId ?? null,
                canManage: overrides?.canManage ?? true,
                onGrant: onGrant as never,
                onRevoke,
            }}
        />,
    );
    return { onGrant, onRevoke };
}

describe("PeopleModal — per-recipient roles", () => {
    it("offers Admin, Member and Viewer for each recipient", async () => {
        renderRoleAware();
        const select = await screen.findByLabelText(
            "Role for counsel@outside.example",
        );
        expect(
            within(select).getAllByRole("option").map((o) => o.textContent),
        ).toEqual(["Admin", "Member", "Viewer"]);
        expect((select as HTMLSelectElement).value).toBe("viewer");
    });

    it("re-roles a recipient through the grants API", async () => {
        const user = userEvent.setup();
        const { onGrant } = renderRoleAware();
        await user.selectOptions(
            await screen.findByLabelText("Role for counsel@outside.example"),
            "admin",
        );
        await waitFor(() =>
            expect(onGrant).toHaveBeenCalledWith(
                "counsel@outside.example",
                "admin",
            ),
        );
    });

    it("shares with an address that has no account yet", async () => {
        const user = userEvent.setup();
        const { onGrant } = renderRoleAware();
        await user.selectOptions(
            await screen.findByLabelText("Role for the new recipient"),
            "viewer",
        );
        await user.click(
            screen.getByPlaceholderText("Add by email..."),
        );
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("newcounsel@outside.example");
        await user.click(screen.getByRole("button", { name: "Add" }));
        await waitFor(() =>
            expect(onGrant).toHaveBeenCalledWith(
                "newcounsel@outside.example",
                "viewer",
            ),
        );
    });

    it("shows the server's own refusal instead of a fixed retry line", async () => {
        // The grants endpoint writes its 400s to be read by a person — "The
        // project creator already has admin access", "role must be admin,
        // member or viewer". `handleAdd` caught them and threw
        // `new Error("Couldn't add the member. Try again.")`, so by the time
        // AddUserInput's own `userFacingApiError` saw it there was no status
        // left to read, and the user was advised to repeat something that
        // would fail identically.
        const user = userEvent.setup();
        renderRoleAware({
            onGrant: () =>
                Promise.reject(
                    new MikeApiError({
                        status: 400,
                        message:
                            "The project creator already has admin access",
                    }),
                ),
        });
        await screen.findByLabelText("Role for the new recipient");
        await user.click(
            screen.getByPlaceholderText("Add by email..."),
        );
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("creator@firm.example2");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(
            await screen.findByText(
                "The project creator already has admin access",
            ),
        ).toBeInTheDocument();
    });

    it("keeps the generic fallback for errors that are not intentional 4xx", async () => {
        // A 500, or a thrown DB message, must not reach the dialog.
        const user = userEvent.setup();
        renderRoleAware({
            onGrant: () =>
                Promise.reject(
                    new MikeApiError({
                        status: 500,
                        message:
                            'duplicate key value violates unique constraint "grants_pkey"',
                    }),
                ),
        });
        await screen.findByLabelText("Role for the new recipient");
        await user.click(
            screen.getByPlaceholderText("Add by email..."),
        );
        // paste, not per-key typing: one input event cannot be cut off
        // mid-word by a slow re-render on a loaded machine.
        await user.paste("someone@firm.example");
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(
            await screen.findByText("Could not add this user. Try again."),
        ).toBeInTheDocument();
        expect(screen.queryByText(/grants_pkey/)).not.toBeInTheDocument();
    });

    it("surfaces the server's message when a re-role is refused", async () => {
        const user = userEvent.setup();
        renderRoleAware({
            onGrant: () =>
                Promise.reject(
                    new MikeApiError({
                        status: 403,
                        message:
                            "Only a project admin can change who has access.",
                    }),
                ),
        });
        await user.selectOptions(
            await screen.findByLabelText("Role for counsel@outside.example"),
            "admin",
        );
        expect(
            await screen.findByText(
                "Only a project admin can change who has access.",
            ),
        ).toBeInTheDocument();
    });

    it("revokes a grant", async () => {
        const user = userEvent.setup();
        const { onRevoke } = renderRoleAware();
        await screen.findByLabelText("Role for counsel@outside.example");
        await user.click(screen.getByTitle("Member actions"));
        await user.click(
            screen.getByRole("button", { name: /remove access/i }),
        );
        await waitFor(() =>
            expect(onRevoke).toHaveBeenCalledWith("counsel@outside.example"),
        );
    });

    it("shows roles read-only to somebody who cannot manage access", async () => {
        renderRoleAware({ canManage: false });
        expect(await screen.findByText("Viewer")).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Role for counsel@outside.example"),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByPlaceholderText("Add by email..."),
        ).not.toBeInTheDocument();
    });

    it("explains that an organization's project is already reachable by its people", async () => {
        renderRoleAware({ orgId: "org-1" });
        expect(
            await screen.findByText(/belongs to an organization/),
        ).toBeInTheDocument();
    });

    it("labels the creator Admin, never Owner", async () => {
        renderRoleAware();
        expect(await screen.findByText("Admin")).toBeInTheDocument();
        expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    });
});

describe("PeopleModal — roleless resources", () => {
    it("keeps the shared_with list path for reviews and shows no role picker", async () => {
        const onSharedWithChange = vi.fn().mockResolvedValue(undefined);
        render(
            <PeopleModal
                open
                onClose={vi.fn()}
                resource={{
                    id: "r1",
                    shared_with: ["colleague@firm.example"],
                }}
                fetchPeople={() =>
                    Promise.resolve({
                        owner: {
                            user_id: "u1",
                            email: "creator@firm.example",
                            display_name: null,
                        },
                        members: [
                            {
                                email: "colleague@firm.example",
                                display_name: null,
                            },
                        ],
                    })
                }
                currentUserEmail="me@firm.example"
                breadcrumb={["Tabular Reviews", "Review", "People"]}
                onSharedWithChange={onSharedWithChange}
            />,
        );
        expect(await screen.findByText("Member")).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Role for colleague@firm.example"),
        ).not.toBeInTheDocument();
    });
    it("shows the /people roster to a member who cannot manage access", async () => {
        // Below access.manage the grant list is never fetched — GET /access
        // is admin-only — so the roster must come from /people, which every
        // viewer of the project may read and which carries each person's
        // effective role. The old behavior rendered only the creator.
        render(
            <PeopleModal
                open
                onClose={vi.fn()}
                resource={PROJECT}
                fetchPeople={peopleResponse}
                currentUserEmail="me@firm.example"
                breadcrumb={["Projects", "Matter", "People"]}
                access={{
                    grants: [],
                    orgId: null,
                    canManage: false,
                    onGrant: vi.fn() as never,
                    onRevoke: vi.fn(),
                }}
            />,
        );
        expect(
            await screen.findByText(/counsel@outside\.example/),
        ).toBeInTheDocument();
        expect(screen.getByText("Viewer")).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Role for counsel@outside.example"),
        ).not.toBeInTheDocument();
    });

    it("annotates a grant the organization already outranks", async () => {
        // The picker edits the GRANT; the server enforces the strongest of
        // every branch. An org admin holding a viewer grant must not render
        // as a viewer with no explanation.
        render(
            <PeopleModal
                open
                onClose={vi.fn()}
                resource={PROJECT}
                fetchPeople={() =>
                    Promise.resolve({
                        owner: {
                            user_id: "u1",
                            email: "creator@firm.example",
                            display_name: "Creator",
                            role: "admin" as const,
                        },
                        members: [
                            {
                                email: "counsel@outside.example",
                                display_name: null,
                                role: "admin" as const,
                            },
                        ],
                    })
                }
                currentUserEmail="me@firm.example"
                breadcrumb={["Projects", "Matter", "People"]}
                access={{
                    grants: [
                        { email: "counsel@outside.example", role: "viewer" },
                    ],
                    orgId: null,
                    canManage: true,
                    onGrant: vi.fn() as never,
                    onRevoke: vi.fn(),
                }}
            />,
        );
        expect(
            await screen.findByText(/Admin via organization/),
        ).toBeInTheDocument();
    });
});
