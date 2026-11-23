import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ByokPage from "./page";

// The keys work in the active workspace runs on: the caller's own in
// Personal, the organization's in its workspace.

const state = vi.hoisted(() => ({
    scope: { kind: "personal" } as
        | { kind: "personal" }
        | { kind: "loading" }
        | { kind: "unavailable" }
        | { kind: "organization"; orgId: string; orgName: string }
        | { kind: "managed"; orgName: string },
}));

const refreshOrganizations = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
    useWorkspace: () => ({ refreshOrganizations }),
}));
vi.mock("@/app/hooks/useWorkspaceSettingsScope", () => ({
    useWorkspaceSettingsScope: () => state.scope,
}));
vi.mock("@/app/components/settings/PersonalProviderKeys", () => ({
    PersonalProviderKeys: () => <p>Your keys</p>,
}));
vi.mock("@/app/components/organizations/OrganizationProviderKeys", () => ({
    OrganizationProviderKeys: ({
        orgId,
        orgName,
    }: {
        orgId: string;
        orgName: string;
    }) => (
        <p>
            Keys for {orgName} ({orgId})
        </p>
    ),
}));

beforeEach(() => {
    state.scope = { kind: "personal" };
});

describe("Settings > Bring Your Own Keys", () => {
    it("manages the caller's own keys in Personal", () => {
        render(<ByokPage />);
        expect(screen.getByText("Your keys")).toBeInTheDocument();
    });

    it("manages the organization's keys for its owners and admins", () => {
        state.scope = { kind: "organization", orgId: "org-1", orgName: "Acme LLP" };
        render(<ByokPage />);
        expect(screen.getByText("Keys for Acme LLP (org-1)")).toBeInTheDocument();
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
