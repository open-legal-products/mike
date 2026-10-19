import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewPlaybookModal } from "./NewPlaybookModal";

describe("NewPlaybookModal", () => {
  it("creates an organization's playbook with the access chosen", async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(
      <NewPlaybookModal
        open
        organizationName="Acme"
        onClose={vi.fn()}
        onCreate={onCreate}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "New playbook" });
    const access = within(dialog).getByRole("group", {
      name: "Organisational Access",
    });
    expect(access).toHaveAccessibleDescription(
      "Only the people you share this playbook with can open it.",
    );
    await userEvent.click(
      within(access).getByRole("button", { name: "Public" }),
    );
    expect(access).toHaveAccessibleDescription(
      "Everyone in Acme can view and run this playbook.",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Playbook name"),
      "Supply terms",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" }),
    );

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Supply terms" }),
        "organization",
      ),
    );
  });
});
