import { render, screen, waitFor, within } from "@testing-library/react";
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

// Whose Features, Model Preferences and keys the active workspace shows;
// Personal unless a test says otherwise.
const settingsScope = vi.hoisted(() => ({
    current: { kind: "personal" } as { kind: string; orgName?: string },
}));
vi.mock("@/app/hooks/useWorkspaceSettingsScope", () => ({
    useWorkspaceSettingsScope: () => settingsScope.current,
}));

describe("SettingsLayout", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        pathname = "/settings/memory";
        vi.mocked(listMyOrgInvitations).mockResolvedValue([]);
        dataActions.canExport = true;
        dataActions.canDelete = true;
        settingsScope.current = { kind: "personal" };
    });

    const WORKSPACE_TABS = [
        "Memory",
        "Connectors",
        "Features",
        "Model Preferences",
        "Bring Your Own Keys",
        "Privacy & Data",
    ];

    it("lists the organization's Features, Model Preferences and keys for its owners and admins", () => {
        settingsScope.current = { kind: "organization", orgName: "Acme LLP" };
        render(
            <SettingsLayout>
                <div />
            </SettingsLayout>,
        );
        expect(
            tabNames(screen.getByRole("list", { name: "Workspace" })),
        ).toEqual(WORKSPACE_TABS);
    });

    it.each(["managed", "loading"])(
        "does not list Features, Model Preferences or keys in an organization's workspace when %s",
        (kind) => {
            settingsScope.current = { kind, orgName: "Acme LLP" };
            render(
                <SettingsLayout>
                    <div />
                </SettingsLayout>,
            );
            expect(
                tabNames(screen.getByRole("list", { name: "Workspace" })),
            ).toEqual(["Memory", "Connectors", "Privacy & Data"]);
        },
    );

    const tabNames = (list: HTMLElement) =>
        within(list)
            .getAllByRole("button")
            .map((button) => button.textContent);

    it("groups the workspace's own settings apart from the person's", () => {
        render(
            <SettingsLayout>
                <div />
            </SettingsLayout>,
        );
        const nav = screen.getByRole("navigation", { name: "Settings" });

        expect(
            tabNames(within(nav).getByRole("list", { name: "Workspace" })),
        ).toEqual(WORKSPACE_TABS);
        expect(
            tabNames(within(nav).getByRole("list", { name: "Personal" })),
        ).toEqual([
            "Account",
            "Personalisation",
            "Appearance",
            "Security",
            "My Activity",
            "Organizations",
        ]);
        // Each section has an icon beside its name, hidden from assistive tech.
        for (const button of within(nav).getAllByRole("button"))
            expect(
                button.querySelector('svg[aria-hidden="true"]'),
            ).not.toBeNull();
    });

    it("marks Account current at the root of Settings, under Personal", () => {
        pathname = "/settings";
        render(
            <SettingsLayout>
                <div />
            </SettingsLayout>,
        );

        const personal = screen.getByRole("list", { name: "Personal" });
        expect(
            within(personal).getByRole("button", { name: "Account" }),
        ).toHaveAttribute("aria-current", "page");
        const workspace = screen.getByRole("list", { name: "Workspace" });
        for (const button of within(workspace).getAllByRole("button"))
            expect(button).not.toHaveAttribute("aria-current");
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
        expect(
            tabNames(screen.getByRole("list", { name: "Workspace" })),
        ).toEqual(WORKSPACE_TABS.filter((tab) => tab !== "Privacy & Data"));
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
