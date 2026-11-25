import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ByokPage from "./page";

// The caller's own keys, in Personal. An organization's keys are managed only
// in its own settings, so its workspace sends owners and admins there.

const state = vi.hoisted(() => ({
    scope: { kind: "personal" } as
        | { kind: "personal" }
        | { kind: "loading" }
        | { kind: "unavailable" }
        | { kind: "organization"; orgId: string; orgName: string }
        | { kind: "managed"; orgName: string },
}));

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace }),
}));

const refreshOrganizations = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({ refreshOrganizations }),
}));
vi.mock("@/app/hooks/useWorkspaceSettingsScope", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/app/hooks/useWorkspaceSettingsScope")
    >()),
    useWorkspaceSettingsScope: () => state.scope,
}));
vi.mock("@/app/components/settings/PersonalProviderKeys", () => ({
    PersonalProviderKeys: () => <p>Your keys</p>,
}));

beforeEach(() => {
    state.scope = { kind: "personal" };
    replace.mockClear();
});

describe("Settings > API Keys", () => {
    it("manages the caller's own keys in Personal", () => {
        render(<ByokPage />);
        expect(screen.getByText("Your keys")).toBeInTheDocument();
        expect(replace).not.toHaveBeenCalled();
    });

    it("sends owners and admins to the organization's own settings for its keys", () => {
        state.scope = { kind: "organization", orgId: "org-1", orgName: "Acme LLP" };
        render(<ByokPage />);
        expect(replace).toHaveBeenCalledWith(
            "/organizations/org-1/settings/providers",
        );
        expect(screen.getByTestId("workspace-settings-loading")).toBeInTheDocument();
        expect(screen.queryByText("Keys for Acme LLP (org-1)")).toBeNull();
        expect(screen.queryByText("Your keys")).toBeNull();
    });

    it("tells a member who manages the keys", () => {
        state.scope = { kind: "managed", orgName: "Acme LLP" };
        render(<ByokPage />);
        expect(
            screen.getByText(
                "Model provider keys in Acme LLP are set by its owners and admins for everyone working there.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByText("Your keys")).toBeNull();
    });

    it("shows nobody's keys, only a skeleton, before the organization has loaded", () => {
        state.scope = { kind: "loading" };
        render(<ByokPage />);
        expect(screen.getByTestId("workspace-settings-loading")).toBeInTheDocument();
        expect(screen.queryByText("Your keys")).toBeNull();
    });

    it("offers Retry when the organizations could not be read", () => {
        state.scope = { kind: "unavailable" };
        render(<ByokPage />);
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Could not load this workspace's settings.",
        );
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(refreshOrganizations).toHaveBeenCalledOnce();
        expect(screen.queryByText("Your keys")).toBeNull();
    });
});
