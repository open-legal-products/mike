import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiKeyField } from "./ApiKeyField";

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
  MfaVerificationPopup: () => null,
  needsMfaVerification: vi.fn().mockResolvedValue(false),
}));

function renderField({
  hasSavedKey = false,
  onSave = vi.fn().mockResolvedValue(true),
  onRemove = vi.fn().mockResolvedValue(true),
}: {
  hasSavedKey?: boolean;
  onSave?: (value: string) => Promise<boolean>;
  onRemove?: () => Promise<boolean>;
} = {}) {
  render(
    <ApiKeyField
      label="Anthropic (Claude) API Key"
      placeholder="sk-ant-..."
      hasSavedKey={hasSavedKey}
      onSave={onSave}
      onRemove={onRemove}
    />,
  );
  const input = screen.getByLabelText(
    "Anthropic (Claude) API Key",
  ) as HTMLInputElement;
  return { input, onSave, onRemove };
}

describe("ApiKeyField", () => {
  it("shows a masked value when a key is saved", () => {
    const { input } = renderField({ hasSavedKey: true });

    expect(input.type).toBe("password");
    expect(input.value.length).toBeGreaterThan(0);
    expect(input.readOnly).toBe(true);
    expect(screen.queryByText("Saved key hidden")).toBeNull();
  });

  it("shows an empty input with the placeholder when no key is saved", () => {
    const { input } = renderField();

    expect(input.value).toBe("");
    expect(input.placeholder).toBe("sk-ant-...");
    expect(input.readOnly).toBe(false);
  });

  it("clears the mask on focus so a replacement key can be entered", async () => {
    const user = userEvent.setup();
    const { input, onSave } = renderField({ hasSavedKey: true });

    await user.click(input);
    expect(input.value).toBe("");
    expect(input.readOnly).toBe(false);

    await user.type(input, "new-key");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("new-key");
  });

  it("restores the mask when focus leaves without a new key", async () => {
    const user = userEvent.setup();
    const { input } = renderField({ hasSavedKey: true });

    await user.click(input);
    await user.tab();

    expect(input.value.length).toBeGreaterThan(0);
    expect(input.readOnly).toBe(true);
  });

  it("shows the warning popup when saving returns false", async () => {
    const user = userEvent.setup();
    renderField({ onSave: vi.fn().mockResolvedValue(false) });

    await user.type(
      screen.getByLabelText("Anthropic (Claude) API Key"),
      "sk-ant-test",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("API key update failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Failed to save Anthropic (Claude) API Key. Please try again.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the warning popup when removing rejects", async () => {
    const user = userEvent.setup();
    renderField({
      hasSavedKey: true,
      onRemove: vi.fn().mockRejectedValue(new Error("network unavailable")),
    });

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("API key update failed")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Failed to remove Anthropic (Claude) API Key. Please try again.",
      ),
    ).toBeInTheDocument();
  });
});
