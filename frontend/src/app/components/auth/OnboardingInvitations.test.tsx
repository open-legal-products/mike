import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import { OnboardingInvitations } from "./OnboardingInvitations";

const mocks = vi.hoisted(() => ({ list: vi.fn(), accept: vi.fn(), changed: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...await original<typeof import("@/app/lib/mikeApi")>(),
    listMyOrgInvitations: mocks.list, acceptOrgInvitation: mocks.accept,
}));
vi.mock("@/app/hooks/useOrganizationInvitationCount", () => ({ notifyOrganizationInvitationsChanged: mocks.changed }));

const invitation = { id: "invite", org_id: "org", org_name: "Example LLP", role: "admin", invited_by_email: "dana@example.test" };
const busy = vi.fn();
const renderInvitations = () => render(<OnboardingInvitations userId="new-user" disabled={false} onBusyChange={busy} />);
beforeEach(() => {
    vi.clearAllMocks(); window.localStorage.clear();
    mocks.list.mockResolvedValue([invitation]);
    mocks.accept.mockResolvedValue({ org_id: "org", role: "admin" });
});

it("shows the organization, offered role and inviter before acceptance", async () => {
    const user = userEvent.setup(); renderInvitations();
    const accept = await screen.findByRole("button", { name: "Accept Example LLP" });
    expect(screen.getByText("Invited as Admin")).toBeVisible();
    expect(screen.getByText("From dana@example.test")).toBeVisible();
    expect(mocks.accept).not.toHaveBeenCalled();
    await user.click(accept);
    expect(await screen.findByText("Joined as Admin")).toBeVisible();
    expect(mocks.accept).toHaveBeenCalledExactlyOnceWith("invite");
    expect(window.localStorage.getItem("mike.activeWorkspace.new-user")).toBe("org");
    expect(mocks.changed).toHaveBeenCalledOnce();
    expect(busy).toHaveBeenLastCalledWith(false);
});

it("shows an empty state for users without invitations", async () => {
    mocks.list.mockResolvedValue([]); renderInvitations();
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
    expect(screen.getByText(/You have no pending invitations/)).toBeVisible();
});

it("allows a failed lookup to be retried and never presents it as an empty list", async () => {
    mocks.list.mockRejectedValueOnce(new Error("raw internal error"));
    const user = userEvent.setup(); renderInvitations();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load your invitations.");
    expect(busy).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Accept Example LLP" })).toBeEnabled();
});

it("keeps failed or expired invitations from selecting a workspace and supports refreshing", async () => {
    mocks.accept.mockRejectedValueOnce(new MikeApiError({ status: 410, message: "That invitation has expired." }));
    const user = userEvent.setup(); renderInvitations();
    await user.click(await screen.findByRole("button", { name: "Accept Example LLP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That invitation has expired.");
    expect(window.localStorage.getItem("mike.activeWorkspace.new-user")).toBeNull();
    expect(mocks.changed).not.toHaveBeenCalled();
    expect(screen.queryByText("Joined")).not.toBeInTheDocument();
    mocks.list.mockResolvedValue([]);
    await user.click(screen.getByRole("button", { name: "Refresh invitations" }));
    expect(await screen.findByText(/You have no pending invitations/)).toBeVisible();
});

it("does not persist a late acceptance after the user leaves onboarding", async () => {
    let resolve!: (value: unknown) => void;
    mocks.accept.mockReturnValue(new Promise((done) => { resolve = done; }));
    const user = userEvent.setup(); const { unmount } = renderInvitations();
    await user.click(await screen.findByRole("button", { name: "Accept Example LLP" }));
    unmount();
    await act(async () => resolve({ org_id: "org", role: "admin" }));
    expect(window.localStorage.getItem("mike.activeWorkspace.new-user")).toBeNull();
    expect(mocks.changed).not.toHaveBeenCalled();
});

it("does not mistake blocked browser storage for a failed invitation acceptance", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
        const user = userEvent.setup(); renderInvitations();
        await user.click(await screen.findByRole("button", { name: "Accept Example LLP" }));
        expect(await screen.findByText("Joined as Admin")).toBeVisible();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally { storage.mockRestore(); }
});
