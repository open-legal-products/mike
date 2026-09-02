import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import OrganizationsPage from "./page";

const api = vi.hoisted(() => ({
    listOrgs: vi.fn(),
    createOrg: vi.fn(),
    listOrgMembers: vi.fn(),
    updateOrgMember: vi.fn(),
    removeOrgMember: vi.fn(),
    listOrgInvitations: vi.fn(),
    createOrgInvitation: vi.fn(),
    cancelOrgInvitation: vi.fn(),
    resendOrgInvitation: vi.fn(),
    listMyOrgInvitations: vi.fn(),
    acceptOrgInvitation: vi.fn(),
    declineOrgInvitation: vi.fn(),
    lookupUserByEmail: vi.fn(),
    MikeApiError: class extends Error {
        status: number;
        code: string | null = null;
        requestId: string | null = null;
        constructor(args: { message: string; status: number }) {
            super(args.message);
            this.status = args.status;
        }
    },
}));

vi.mock("@/app/lib/mikeApi", () => api);
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "me", email: "me@firm.com" },
        isAuthenticated: true,
        authLoading: false,
    }),
}));

const FIRM = {
    id: "org-1",
    name: "Acme Legal",
    created_by: "me",
    role: "admin" as const,
    member_count: 2,
};

const PENDING_INVITE = {
    id: "inv-1",
    org_id: "org-1",
    email: "counsel@firm.com",
    role: "member" as const,
    invited_by: "me",
    status: "pending" as const,
    expires_at: "2099-01-01T00:00:00.000Z",
    created_at: "2026-08-01T00:00:00.000Z",
    accepted_at: null,
    declined_at: null,
    cancelled_at: null,
    invited_by_email: "me@firm.com",
};

beforeEach(() => {
    vi.clearAllMocks();
    api.listOrgs.mockResolvedValue([FIRM]);
    api.listOrgMembers.mockResolvedValue([
        {
            id: "m1",
            user_id: "me",
            role: "admin",
            email: "me@firm.com",
            display_name: "Me",
        },
        {
            id: "m2",
            user_id: "u2",
            role: "member",
            email: "colleague@firm.com",
            display_name: "Colleague",
        },
    ]);
    api.listOrgInvitations.mockResolvedValue([]);
    api.listMyOrgInvitations.mockResolvedValue([]);
});

describe("OrganizationsPage roles", () => {
    it("offers only Admin and Member, never Owner", async () => {
        const user = userEvent.setup();
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        const roleSelect = await screen.findByLabelText("Role for Colleague");
        expect(
            within(roleSelect).getAllByRole("option").map((o) => o.textContent),
        ).toEqual(["Admin", "Member"]);
        expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    });

    it("changes a member's role", async () => {
        const user = userEvent.setup();
        api.updateOrgMember.mockResolvedValue({});
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        expect(await screen.findByText(/Colleague/)).toBeInTheDocument();
        expect(screen.getByText("(You)")).toBeInTheDocument();

        await user.selectOptions(
            screen.getByLabelText("Role for Colleague"),
            "admin",
        );
        await waitFor(() =>
            expect(api.updateOrgMember).toHaveBeenCalledWith(
                "org-1",
                "u2",
                "admin",
            ),
        );
    });

    it("surfaces the last-admin guard inline", async () => {
        const user = userEvent.setup();
        api.updateOrgMember.mockRejectedValue(
            new api.MikeApiError({
                message: "An organization must keep at least one admin.",
                status: 409,
            }),
        );
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        await user.selectOptions(
            await screen.findByLabelText("Role for Colleague"),
            "admin",
        );

        expect(
            await screen.findByText(
                "An organization must keep at least one admin.",
            ),
        ).toBeInTheDocument();
    });

    it("hides management affordances from plain members", async () => {
        const user = userEvent.setup();
        api.listOrgs.mockResolvedValue([{ ...FIRM, role: "member" as const }]);
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        await screen.findByText(/Colleague/);
        expect(
            screen.queryByPlaceholderText("Invite by email…"),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByLabelText("Role for Colleague"),
        ).not.toBeInTheDocument();
        // The invitation roster is administrative detail; the server refuses
        // it to members, so the page must not ask on their behalf.
        expect(api.listOrgInvitations).not.toHaveBeenCalled();
    });
});

describe("OrganizationsPage invitations — admin side", () => {
    it("sends an invitation at the chosen role instead of adding a member", async () => {
        const user = userEvent.setup();
        api.createOrgInvitation.mockResolvedValue(PENDING_INVITE);
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        await user.selectOptions(
            await screen.findByLabelText("Role for the invitation"),
            "admin",
        );
        await user.type(
            screen.getByPlaceholderText("Invite by email…"),
            "counsel@firm.com",
        );
        await user.click(screen.getByRole("button", { name: "Add" }));

        await waitFor(() =>
            expect(api.createOrgInvitation).toHaveBeenCalledWith(
                "org-1",
                "counsel@firm.com",
                "admin",
            ),
        );
        // An invitation is addressed to somebody who may not have an account
        // yet, so the form must not gate on a user lookup.
        expect(api.lookupUserByEmail).not.toHaveBeenCalled();
    });

    it("lists pending invitations apart from the member roster, with cancel and resend", async () => {
        const user = userEvent.setup();
        api.listOrgInvitations.mockResolvedValue([PENDING_INVITE]);
        api.resendOrgInvitation.mockResolvedValue({
            ...PENDING_INVITE,
            expires_at: "2099-02-01T00:00:00.000Z",
        });
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        const row = await screen.findByTestId("pending-invitation");
        expect(within(row).getByText("counsel@firm.com")).toBeInTheDocument();
        expect(within(row).getByText("Pending")).toBeInTheDocument();
        expect(
            within(row).getByText(/No access until accepted/),
        ).toBeInTheDocument();

        // The invitee is not a member until they accept: no roster row, and
        // therefore no member role control, bears their address.
        expect(
            screen.queryByLabelText("Role for counsel@firm.com"),
        ).not.toBeInTheDocument();

        await user.click(
            within(row).getByLabelText(
                "Resend invitation to counsel@firm.com",
            ),
        );
        await waitFor(() =>
            expect(api.resendOrgInvitation).toHaveBeenCalledWith(
                "org-1",
                "inv-1",
            ),
        );

        await user.click(
            within(
                await screen.findByTestId("pending-invitation"),
            ).getByLabelText("Cancel invitation to counsel@firm.com"),
        );
        await waitFor(() =>
            expect(api.cancelOrgInvitation).toHaveBeenCalledWith(
                "org-1",
                "inv-1",
            ),
        );
    });

    it("marks an expired invitation as expired rather than pending", async () => {
        const user = userEvent.setup();
        api.listOrgInvitations.mockResolvedValue([
            { ...PENDING_INVITE, status: "expired" },
        ]);
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        const row = await screen.findByTestId("pending-invitation");
        expect(within(row).getByText("Expired")).toBeInTheDocument();
        expect(within(row).getByText(/Resend to reopen it/)).toBeInTheDocument();
    });

    it("keeps answered invitations out of the roster", async () => {
        const user = userEvent.setup();
        api.listOrgInvitations.mockResolvedValue([
            { ...PENDING_INVITE, id: "inv-2", status: "accepted" },
            { ...PENDING_INVITE, id: "inv-3", status: "declined" },
            { ...PENDING_INVITE, id: "inv-4", status: "cancelled" },
        ]);
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        await screen.findByText(/Colleague/);
        expect(
            screen.queryByTestId("pending-invitation"),
        ).not.toBeInTheDocument();
    });

    it("reports a duplicate invitation as the intentional conflict it is", async () => {
        const user = userEvent.setup();
        api.createOrgInvitation.mockRejectedValue(
            new api.MikeApiError({
                message: "That person already has a pending invitation.",
                status: 409,
            }),
        );
        render(<OrganizationsPage />);

        await user.click(await screen.findByText("Acme Legal"));
        await user.type(
            await screen.findByPlaceholderText("Invite by email…"),
            "counsel@firm.com",
        );
        await user.click(screen.getByRole("button", { name: "Add" }));

        expect(
            await screen.findByText(
                "That person already has a pending invitation.",
            ),
        ).toBeInTheDocument();
    });
});

describe("OrganizationsPage invitations — recipient side", () => {
    const INBOX = [
        {
            ...PENDING_INVITE,
            id: "inv-9",
            email: "me@firm.com",
            role: "admin" as const,
            org_name: "Beta Chambers",
        },
    ];

    it("shows an invitation with its role before it is accepted", async () => {
        api.listMyOrgInvitations.mockResolvedValue(INBOX);
        render(<OrganizationsPage />);

        const invite = (
            await screen.findByText(/Beta Chambers invited you to join as/)
        ).closest("li") as HTMLElement;
        expect(within(invite).getByText("Admin")).toBeInTheDocument();
        expect(
            within(invite).getByText(/Invited by me@firm.com/),
        ).toBeInTheDocument();
    });

    it("accepts an invitation and reloads the organizations it opens", async () => {
        const user = userEvent.setup();
        api.listMyOrgInvitations.mockResolvedValue(INBOX);
        api.acceptOrgInvitation.mockResolvedValue({
            org_id: "org-2",
            role: "admin",
        });
        render(<OrganizationsPage />);

        await user.click(await screen.findByRole("button", { name: /accept/i }));
        await waitFor(() =>
            expect(api.acceptOrgInvitation).toHaveBeenCalledWith("inv-9"),
        );
        // Membership only exists after acceptance, so the roster is re-read.
        await waitFor(() => expect(api.listOrgs).toHaveBeenCalledTimes(2));
    });

    it("declines an invitation", async () => {
        const user = userEvent.setup();
        api.listMyOrgInvitations.mockResolvedValue(INBOX);
        render(<OrganizationsPage />);

        await user.click(
            await screen.findByRole("button", { name: /decline/i }),
        );
        await waitFor(() =>
            expect(api.declineOrgInvitation).toHaveBeenCalledWith("inv-9"),
        );
    });

    it("explains an expired invitation instead of failing silently", async () => {
        const user = userEvent.setup();
        api.listMyOrgInvitations.mockResolvedValue(INBOX);
        api.acceptOrgInvitation.mockRejectedValue(
            new api.MikeApiError({
                message: "That invitation has expired.",
                status: 410,
            }),
        );
        render(<OrganizationsPage />);

        await user.click(await screen.findByRole("button", { name: /accept/i }));
        expect(
            await screen.findByText(
                "That invitation has expired. Ask an admin to send a new one.",
            ),
        ).toBeInTheDocument();
    });

    it("explains an invitation that was already answered or cancelled", async () => {
        const user = userEvent.setup();
        api.listMyOrgInvitations.mockResolvedValue(INBOX);
        api.acceptOrgInvitation.mockRejectedValue(
            new api.MikeApiError({
                message: "Invitation not found",
                status: 404,
            }),
        );
        render(<OrganizationsPage />);

        await user.click(await screen.findByRole("button", { name: /accept/i }));
        expect(
            await screen.findByText(
                "That invitation is no longer available. It may have been cancelled.",
            ),
        ).toBeInTheDocument();
    });
});

describe("OrganizationsPage organizations", () => {
    it("creates an organization", async () => {
        const user = userEvent.setup();
        api.createOrg.mockResolvedValue({
            id: "org-2",
            name: "New Firm",
            created_by: "me",
            role: "admin",
        });
        render(<OrganizationsPage />);
        await screen.findByText("Acme Legal");

        await user.type(
            screen.getByPlaceholderText("New organization name…"),
            "New Firm",
        );
        await user.click(
            screen.getByRole("button", { name: /create organization/i }),
        );

        expect(api.createOrg).toHaveBeenCalledWith("New Firm");
        expect(await screen.findByText("New Firm")).toBeInTheDocument();
    });

    it("lists every organization — there is no hidden personal one to filter", async () => {
        render(<OrganizationsPage />);
        expect(await screen.findByText("Acme Legal")).toBeInTheDocument();
        expect(screen.getByText("2 members")).toBeInTheDocument();
    });
});
