import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeletedOrganizations } from "./DeletedOrganizations";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  restore: vi.fn(),
  refresh: vi.fn(),
  mfa: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/mikeApi")>()),
  listDeletedOrganizations: mocks.list,
  restoreOrganization: mocks.restore,
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => ({ refreshOrganizations: mocks.refresh }),
}));
vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
  needsMfaVerification: mocks.mfa,
  MfaVerificationPopup: () => null,
}));
const org = {
  id: "org",
  name: "Synthetic firm",
  deleted_at: "2026-10-14T00:00:00Z",
  purge_after: "2026-11-13T00:00:00Z",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([org]);
  mocks.restore.mockResolvedValue(undefined);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.mfa.mockResolvedValue(false);
});
describe("organization recovery", () => {
  it("shows the deadline and restores from Settings without switching into a deleted workspace", async () => {
    const user = userEvent.setup();
    const changed = vi.fn(async () => {});
    render(<DeletedOrganizations onRestored={changed} />);
    const restore = await screen.findByRole("button", {
      name: "Restore Synthetic firm",
    });
    expect(screen.getByText(/Recover before/)).toBeInTheDocument();
    mocks.list.mockResolvedValue([]);
    await user.click(restore);
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(mocks.restore).toHaveBeenCalledWith("org");
    expect(mocks.refresh).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Restore Synthetic firm" }),
      ).not.toBeInTheDocument(),
    );
  });
  it("keeps the recovery control available after a failed restore", async () => {
    mocks.restore.mockRejectedValue(new Error("internal database detail"));
    const user = userEvent.setup();
    render(<DeletedOrganizations onRestored={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "Restore Synthetic firm" }),
    );
    await screen.findByText("Could not restore the organization.");
    expect(
      screen.queryByText("internal database detail"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restore Synthetic firm" }),
    ).not.toBeDisabled();
  });
  it("does not mistake a failed list request for an empty recovery list", async () => {
    mocks.list.mockRejectedValue(new Error("offline"));
    render(<DeletedOrganizations onRestored={vi.fn()} />);
    await screen.findByRole("button", { name: "Retry deleted organizations" });
  });
});
