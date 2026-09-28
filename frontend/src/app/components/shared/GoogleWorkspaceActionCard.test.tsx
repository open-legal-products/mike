import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleWorkspaceActionReview } from "@mike/contracts";
import { InlineGoogleWorkspaceAction } from "./GoogleWorkspaceActionCard";
import * as api from "@/app/lib/mikeApi";

vi.mock("@/app/lib/mikeApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/mikeApi")>()),
  listGoogleWorkspaceActions: vi.fn(),
  decideGoogleWorkspaceAction: vi.fn(),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
  MfaVerificationPopup: () => null,
}));

const pending: GoogleWorkspaceActionReview = {
  id: "action-1",
  provider: "gmail",
  status: "pending",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  resultMessage: null,
  proposal: {
    tool: "gmail_propose_send",
    accountEmail: "sender@example.com",
    args: {
      to: ["recipient@example.com"],
      subject: "Contract update",
      body: "Exact proposed body",
    },
  },
};

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => cleanup());

describe("InlineGoogleWorkspaceAction", () => {
  it("renders the exact proposal inline and executes only after approval", async () => {
    vi.mocked(api.listGoogleWorkspaceActions)
      .mockResolvedValueOnce({ actions: [pending] })
      .mockResolvedValueOnce({
        actions: [
          {
            ...pending,
            status: "succeeded",
            resultMessage: "Google confirmed this action completed.",
          },
        ],
      });
    vi.mocked(api.decideGoogleWorkspaceAction).mockResolvedValue({
      status: "succeeded",
      message: "Google confirmed this action completed.",
    });

    render(<InlineGoogleWorkspaceAction actionId="action-1" />);

    expect(await screen.findByText("Exact proposed body")).toBeVisible();
    expect(screen.getByText("recipient@example.com")).toBeVisible();
    expect(api.decideGoogleWorkspaceAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Approve send email" }));

    await waitFor(() =>
      expect(api.decideGoogleWorkspaceAction).toHaveBeenCalledWith(
        "action-1",
        "approve",
      ),
    );
    expect(
      await screen.findByText("Google confirmed this action completed."),
    ).toBeVisible();
  });

  it("rejects the proposal from the same inline card", async () => {
    vi.mocked(api.listGoogleWorkspaceActions)
      .mockResolvedValueOnce({ actions: [pending] })
      .mockResolvedValueOnce({
        actions: [
          { ...pending, status: "rejected", resultMessage: "Rejected by you." },
        ],
      });
    vi.mocked(api.decideGoogleWorkspaceAction).mockResolvedValue(undefined);

    render(<InlineGoogleWorkspaceAction actionId="action-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(api.decideGoogleWorkspaceAction).toHaveBeenCalledWith(
        "action-1",
        "reject",
      ),
    );
    expect(await screen.findByText("Rejected by you.")).toBeVisible();
  });
});
