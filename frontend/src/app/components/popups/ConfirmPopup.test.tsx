import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { withIntl } from "@/test/withIntl";
import { ConfirmPopup } from "./ConfirmPopup";

describe("ConfirmPopup", () => {
  it("uses the configured danger variant for non-Delete labels", () => {
    render(
      withIntl(
        <ConfirmPopup
          open
          title="Remove members?"
          confirmLabel="Remove"
          confirmVariant="danger"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );

    expect(screen.getByRole("button", { name: "Remove" })).toHaveClass(
      "bg-red-600/90",
    );
  });

  it("does not infer the button variant from its label", () => {
    render(
      withIntl(
        <ConfirmPopup
          open
          title="Continue?"
          confirmLabel="Delete"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />,
      ),
    );

    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass(
      "bg-gray-950/88",
    );
  });
});
