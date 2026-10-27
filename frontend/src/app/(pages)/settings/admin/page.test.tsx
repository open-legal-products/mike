import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
    AdminUserFeatureFlags,
    FeatureFlagSummary,
} from "@mike/contracts";
import {
    getAdminFeatureFlags,
    getAdminUserFeatureFlags,
    setAdminFeatureFlagDefault,
    setAdminUserFeatureFlag,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import AdminPage from "./page";

const state = vi.hoisted(() => ({
    profile: { instanceAdmin: true } as { instanceAdmin: boolean } | null,
    loading: false,
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: state.profile, loading: state.loading }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getAdminFeatureFlags: vi.fn(),
    getAdminUserFeatureFlags: vi.fn(),
    setAdminFeatureFlagDefault: vi.fn(),
    setAdminUserFeatureFlag: vi.fn(),
}));

vi.mock("@/app/lib/userFacingError", async (original) => ({
    ...(await original<typeof import("@/app/lib/userFacingError")>()),
    notifyError: vi.fn(),
}));

const flag = (
    key: FeatureFlagSummary["key"],
    label: string,
    overrides: Partial<FeatureFlagSummary> = {},
): FeatureFlagSummary => ({
    key,
    label,
    description: `${label} description`,
    group: "Google",
    codeDefault: true,
    deploymentDefault: null,
    effectiveDefault: true,
    ...overrides,
});

const FLAGS: FeatureFlagSummary[] = [
    flag("google-drive", "Google Drive"),
    flag("gmail-read", "Gmail: read", {
        codeDefault: false,
        deploymentDefault: null,
        effectiveDefault: false,
    }),
];

const PAT: AdminUserFeatureFlags = {
    userId: "22222222-2222-4222-8222-222222222222",
    email: "pat@example.com",
    displayName: "Pat",
    flags: [
        { key: "google-drive", override: null, enabled: true },
        { key: "gmail-read", override: null, enabled: false },
    ],
};

describe("AdminPage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.profile = { instanceAdmin: true };
        state.loading = false;
        vi.mocked(getAdminFeatureFlags).mockResolvedValue({ flags: FLAGS });
    });

    it("tells a non-admin there is nothing here and loads nothing", () => {
        state.profile = { instanceAdmin: false };
        render(<AdminPage />);
        expect(screen.getByRole("status")).toHaveTextContent(
            "Only administrators of this Mike server can open this page.",
        );
        expect(getAdminFeatureFlags).not.toHaveBeenCalled();
    });

    it("shows each flag's default with where it comes from and saves a new default", async () => {
        vi.mocked(setAdminFeatureFlagDefault).mockResolvedValue({
            flags: [
                FLAGS[0],
                flag("gmail-read", "Gmail: read", {
                    codeDefault: false,
                    deploymentDefault: true,
                    effectiveDefault: true,
                }),
            ],
        });
        const user = userEvent.setup();
        render(<AdminPage />);

        const gmail = await screen.findByRole("switch", { name: "Gmail: read default" });
        expect(gmail).toHaveAttribute("aria-checked", "false");
        expect(
            screen.getByText("Default from server configuration: off."),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Use server configuration" }),
        ).toBeNull();

        await user.click(gmail);
        await waitFor(() =>
            expect(setAdminFeatureFlagDefault).toHaveBeenCalledWith("gmail-read", true),
        );
        expect(
            await screen.findByText("Set here; server configuration says off."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("switch", { name: "Gmail: read default" }),
        ).toHaveAttribute("aria-checked", "true");

        // The one "Use server configuration" button clears that default.
        await user.click(screen.getByRole("button", { name: "Use server configuration" }));
        await waitFor(() =>
            expect(setAdminFeatureFlagDefault).toHaveBeenLastCalledWith("gmail-read", null),
        );
    });

    it("keeps the toggle where it was and reports a failed save", async () => {
        vi.mocked(setAdminFeatureFlagDefault).mockRejectedValue(new Error("boom"));
        const user = userEvent.setup();
        render(<AdminPage />);
        const drive = await screen.findByRole("switch", { name: "Google Drive default" });
        await user.click(drive);
        await waitFor(() => expect(notifyError).toHaveBeenCalled());
        expect(
            screen.getByRole("switch", { name: "Google Drive default" }),
        ).toHaveAttribute("aria-checked", "true");
    });

    it("looks a user up by email, shows their flags, and sets an override", async () => {
        vi.mocked(getAdminUserFeatureFlags).mockResolvedValue(PAT);
        vi.mocked(setAdminUserFeatureFlag).mockResolvedValue({
            ...PAT,
            flags: [
                PAT.flags[0],
                { key: "gmail-read", override: true, enabled: true },
            ],
        });
        const user = userEvent.setup();
        render(<AdminPage />);
        await screen.findByRole("switch", { name: "Google Drive default" });

        const lookup = screen.getByRole("button", { name: "Look up" });
        expect(lookup).toBeDisabled();
        await user.type(screen.getByLabelText("Email address"), "pat@example.com");
        await user.click(lookup);
        await waitFor(() =>
            expect(getAdminUserFeatureFlags).toHaveBeenCalledWith("pat@example.com"),
        );
        expect(await screen.findByText("Pat")).toBeInTheDocument();
        expect(screen.getByText("pat@example.com")).toBeInTheDocument();

        // Each flag row describes the current choice: following the default.
        const gmailRow = screen.getByRole("button", { name: "Gmail: read" });
        expect(gmailRow).toHaveTextContent("Default (off)");
        await user.click(gmailRow);
        await user.click(await screen.findByRole("menuitemradio", { name: /^On/ }));
        await waitFor(() =>
            expect(setAdminUserFeatureFlag).toHaveBeenCalledWith(
                PAT.userId,
                "gmail-read",
                true,
            ),
        );
        expect(
            await screen.findByText("On for this account."),
        ).toBeInTheDocument();
    });

    it("says in place when no account has the address", async () => {
        vi.mocked(getAdminUserFeatureFlags).mockRejectedValue(
            Object.assign(new Error("No account has that email address."), {
                status: 404,
            }),
        );
        const user = userEvent.setup();
        render(<AdminPage />);
        await screen.findByRole("switch", { name: "Google Drive default" });
        await user.type(screen.getByLabelText("Email address"), "nobody@example.com");
        await user.click(screen.getByRole("button", { name: "Look up" }));
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "No account has that email address.",
        );
        expect(notifyError).not.toHaveBeenCalled();
        const defaults = within(
            screen.getByRole("region", { name: "User overrides" }),
        );
        expect(defaults.queryByRole("button", { name: "Gmail: read" })).toBeNull();
    });
});
