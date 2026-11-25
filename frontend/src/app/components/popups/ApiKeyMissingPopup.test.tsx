import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSettingsScope } from "@/app/hooks/useWorkspaceSettingsScope";
import { ApiKeyMissingPopup } from "./ApiKeyMissingPopup";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push }),
}));

const state = vi.hoisted(() => ({
    scope: { kind: "personal" } as WorkspaceSettingsScope,
}));
vi.mock("@/app/hooks/useWorkspaceSettingsScope", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/app/hooks/useWorkspaceSettingsScope")
    >()),
    useWorkspaceSettingsScope: () => state.scope,
}));

beforeEach(() => {
    push.mockClear();
    state.scope = { kind: "personal" };
});

describe("ApiKeyMissingPopup", () => {
    it("opens the caller's own keys in Personal", () => {
        const onClose = vi.fn();
        render(<ApiKeyMissingPopup open onClose={onClose} />);
        fireEvent.click(screen.getByRole("button", { name: "Go to settings" }));
        expect(onClose).toHaveBeenCalledOnce();
        expect(push).toHaveBeenCalledWith("/settings/byok");
    });

    it("opens the organization's own settings for its owners and admins", () => {
        state.scope = { kind: "organization", orgId: "org-1", orgName: "Acme LLP" };
        render(<ApiKeyMissingPopup open onClose={() => {}} />);
        fireEvent.click(screen.getByRole("button", { name: "Go to settings" }));
        expect(push).toHaveBeenCalledWith(
            "/organizations/org-1/settings/providers",
        );
    });

    it("tells a member to ask the organization's owners or admins, with nowhere to go", () => {
        state.scope = { kind: "managed", orgName: "Acme LLP" };
        render(<ApiKeyMissingPopup open onClose={() => {}} />);
        expect(
            screen.getByText(
                "No models are enabled in Acme LLP yet. Ask one of its owners or admins to add an API key.",
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Go to settings" })).toBeNull();
    });
});
