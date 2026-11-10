import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMyOrgInvitations, type OrgInvitation } from "@/app/lib/mikeApi";
import SettingsLayout from "./layout";

const push = vi.fn();
let pathname = "/settings/memory";

vi.mock("next/navigation", () => ({
    usePathname: () => pathname,
    useRouter: () => ({ push }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        isAuthenticated: true,
        authLoading: false,
        user: { id: "me" },
    }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    listMyOrgInvitations: vi.fn(),
}));

// What Privacy & Data may do in the active workspace; everything unless a
// test says otherwise.
const dataActions = vi.hoisted(() => ({ canExport: true, canDelete: true }));
vi.mock("@/app/hooks/useMemberDataActions", () => ({
    useMemberDataActions: () => dataActions,
}));

// Whether the server lists this account in MIKE_ADMIN_EMAILS.
const profileState = vi.hoisted(() => ({ instanceAdmin: false }));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useOptionalUserProfile: () => ({
        profile: { instanceAdmin: profileState.instanceAdmin },
        loading: false,
    }),
}));

describe("SettingsLayout", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pathname = "/settings/memory";
        vi.mocked(listMyOrgInvitations).mockResolvedValue([]);
        dataActions.canExport = true;
        dataActions.canDelete = true;
        profileState.instanceAdmin = false;
    });

    it("lists Admin only for an instance admin", () => {
        render(
            <SettingsLayout>
                <div />
            </SettingsLayout>,
        );
        expect(screen.queryByRole("button", { name: "Admin" })).toBeNull();
    });

    it("lists Admin for an instance admin", () => {
        profileState.instanceAdmin = true;
        render(
            <SettingsLayout>
                <div />
            </SettingsLayout>,
        );
        expect(screen.getByRole("button", { name: "Admin" })).toBeInTheDocument();
    });

    it("lists Privacy & Data while it has an export or a delete to offer", () => {
        dataActions.canDelete = false;
        render(
            <SettingsLayout>
                <div />
            </SettingsLayout>,
        );
        expect(
            screen.getByRole("button", { name: "Privacy & Data" }),
        ).toBeInTheDocument();
    });

    it("does not list Privacy & Data when the organization allows members neither", () => {
        dataActions.canExport = false;
        dataActions.canDelete = false;
        render(
            <SettingsLayout>
                <div />
            </SettingsLayout>,
        );
        expect(
            screen.queryByRole("button", { name: "Privacy & Data" }),
        ).toBeNull();
        expect(screen.getByRole("button", { name: "Memory" })).toBeInTheDocument();
    });

    it("exposes Memory as a dedicated settings page and marks it current", async () => {
        const user = userEvent.setup();
        render(
            <SettingsLayout>
                <div>Memory content</div>
            </SettingsLayout>,
        );

        const memoryTab = screen.getByRole("button", { name: "Memory" });
        expect(memoryTab).toHaveAttribute("aria-current", "page");
        expect(screen.getByText("Memory content")).toBeVisible();

        await user.click(screen.getByRole("button", { name: "Features" }));
        expect(push).toHaveBeenCalledWith("/settings/features");
    });

    it("links to My Activity from Settings", async () => {
        const user = userEvent.setup();
        render(
            <SettingsLayout>
                <div>Activity content</div>
            </SettingsLayout>,
        );

        const activityTab = screen.getByRole("button", { name: "My Activity" });
        await user.click(activityTab);
        expect(push).toHaveBeenCalledWith("/settings/my-activity");
    });

    it("lets My Activity use a full table page outside the settings frame", () => {
        pathname = "/settings/my-activity";
        render(
            <SettingsLayout>
                <div>Activity table</div>
            </SettingsLayout>,
        );

        expect(screen.getByText("Activity table")).toBeVisible();
        expect(
            screen.queryByRole("navigation", { name: "Settings" }),
        ).toBeNull();
        expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    });

    it("shows the pending invitation count beside Organizations and opens the page", async () => {
        vi.mocked(listMyOrgInvitations).mockResolvedValue([
            { id: "invite-1" },
            { id: "invite-2" },
        ] as OrgInvitation[]);
        const user = userEvent.setup();
        render(
            <SettingsLayout>
                <div>Settings content</div>
            </SettingsLayout>,
        );

        const organizations = await screen.findByRole("button", {
            name: /Organizations/,
        });
        await waitFor(() =>
            expect(organizations).toHaveAccessibleName(
                "Organizations 2 pending invitations",
            ),
        );
        await user.click(organizations);
        expect(push).toHaveBeenCalledWith("/settings/organizations");
    });
});
