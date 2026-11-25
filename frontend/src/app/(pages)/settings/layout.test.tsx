import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMyOrgInvitations, type OrgInvitation } from "@/app/lib/mikeApi";
import { SettingsOverview } from "@/app/components/settings/SettingsOverview";
import SettingsLayout from "./layout";

// The page header's breadcrumbs measure themselves against a media query.
vi.stubGlobal(
  "matchMedia",
  vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })),
);

const push = vi.fn();
let pathname = "/settings";

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
        pathname = "/settings";
        vi.mocked(listMyOrgInvitations).mockResolvedValue([]);
        dataActions.canExport = true;
        dataActions.canDelete = true;
        settingsScope.current = { kind: "personal" };
    });

    const WORKSPACE_SECTIONS = [
        "Memory",
        "Connectors",
        "Features",
        "Model Preferences",
        "API Keys",
        "Privacy & Data",
    ];

    // Settings' own address is its overview: every section as a card.
    const renderOverview = () =>
        render(
            <SettingsLayout>
                <SettingsOverview />
            </SettingsLayout>,
        );

    const sectionNames = (group: string) =>
        within(screen.getByRole("region", { name: group }))
            .getAllByRole("link")
            .map((link) => {
                const label = link.getAttribute("aria-labelledby");
                return label ? document.getElementById(label)?.textContent : null;
            });

    it("shows the caller's own keys in Personal", () => {
        renderOverview();
        expect(sectionNames("Workspace")).toEqual(WORKSPACE_SECTIONS);
    });

    it("shows the organization's Features and Model Preferences to its owners and admins, but not its keys", () => {
        settingsScope.current = { kind: "organization", orgName: "Acme LLP" };
        renderOverview();
        // An organization's keys are managed only in its own settings.
        expect(sectionNames("Workspace")).toEqual(
            WORKSPACE_SECTIONS.filter((section) => section !== "API Keys"),
        );
    });

    it("does not show Features, Model Preferences or keys in an organization's workspace the caller does not manage", () => {
        settingsScope.current = { kind: "managed", orgName: "Acme LLP" };
        renderOverview();
        expect(sectionNames("Workspace")).toEqual([
            "Memory",
            "Connectors",
            "Privacy & Data",
        ]);
    });

    it("holds the overview's place until the workspace's sections are known", () => {
        settingsScope.current = { kind: "loading" };
        const { container } = renderOverview();
        expect(screen.queryByRole("link")).toBeNull();
        expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    });

    it("groups the workspace's own settings apart from the person's, each with its icon and what it holds", () => {
        renderOverview();
        // The person's own settings come first.
        expect(
            screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
        ).toEqual(["Personal", "Workspace"]);
        expect(sectionNames("Workspace")).toEqual(WORKSPACE_SECTIONS);
        expect(sectionNames("Personal")).toEqual([
            "Account",
            "Personalisation",
            "Appearance",
            "Security",
            "My Activity",
            "Organizations",
        ]);
        for (const link of screen.getAllByRole("link")) {
            // The icon is decoration beside the name.
            expect(link.querySelector('img[aria-hidden="true"]')).not.toBeNull();
            expect(link).toHaveAccessibleDescription(/\w/);
        }
        expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute(
            "href",
            "/settings/account",
        );
        expect(screen.getByRole("link", { name: "Memory" })).toHaveAttribute(
            "href",
            "/settings/memory",
        );
    });

    it("names only Settings in the header on the overview", () => {
        renderOverview();
        expect(
            screen.queryByRole("button", { name: "Back to Settings" }),
        ).toBeNull();
    });

    it("shows Privacy & Data while it has an export or a delete to offer", () => {
        dataActions.canDelete = false;
        renderOverview();
        expect(
            screen.getByRole("link", { name: "Privacy & Data" }),
        ).toBeInTheDocument();
    });

    it("does not show Privacy & Data when the organization allows members neither", () => {
        dataActions.canExport = false;
        dataActions.canDelete = false;
        renderOverview();
        expect(screen.queryByRole("link", { name: "Privacy & Data" })).toBeNull();
        expect(sectionNames("Workspace")).toEqual(
            WORKSPACE_SECTIONS.filter((section) => section !== "Privacy & Data"),
        );
    });

    it("names the open section in the header, with Settings leading back to the overview", async () => {
        const user = userEvent.setup();
        pathname = "/settings/memory";
        render(
            <SettingsLayout>
                <div>Memory content</div>
            </SettingsLayout>,
        );

        expect(screen.getByText("Memory content")).toBeVisible();
        expect(screen.getAllByText("Memory").length).toBeGreaterThan(0);
        const back = screen
            .getAllByTitle("Back to Settings")
            .find((element) => element.tagName === "BUTTON");
        expect(back).toBeDefined();
        await user.click(back!);
        expect(push).toHaveBeenCalledWith("/settings");
    });

    it("lets My Activity use a full table page outside the settings frame", () => {
        pathname = "/settings/my-activity";
        render(
            <SettingsLayout>
                <div>Activity table</div>
            </SettingsLayout>,
        );

        expect(screen.getByText("Activity table")).toBeVisible();
        expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
    });

    it("shows the pending invitation count beside Organizations", async () => {
        vi.mocked(listMyOrgInvitations).mockResolvedValue([
            { id: "invite-1" },
            { id: "invite-2" },
        ] as OrgInvitation[]);
        renderOverview();

        await waitFor(() =>
            expect(
                screen.getByRole("link", { name: /Organizations/ }),
            ).toHaveAccessibleName("Organizations 2 pending invitations"),
        );
        expect(
            screen.getByRole("link", { name: /Organizations/ }),
        ).toHaveAttribute("href", "/settings/organizations");
    });
});
