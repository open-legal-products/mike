import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
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

  it("shows an empty input without a placeholder when no key is saved", () => {
    const { input } = renderField();

    expect(input.value).toBe("");
    expect(input).not.toHaveAttribute("placeholder");
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

  it("shows the server's reason for a rejected value instead of asking to retry", async () => {
    const user = userEvent.setup();
    const reason =
      "A public https base URL (for example https://llm.example.com/v1) is required with an OpenAI-compatible endpoint key.";
    renderField({
      onSave: vi
        .fn()
        .mockRejectedValue(new MikeApiError({ message: reason, status: 400 })),
    });

    await user.type(
      screen.getByLabelText("Anthropic (Claude) API Key"),
      "sk-test",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/Please try again/)).toBeNull();
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

describe("ApiKeyField with a required setting", () => {
  const regionSetting = {
    label: "AWS region",
    placeholder: "us-east-1",
    normalize: (value: string) =>
      /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value.trim().toLowerCase())
        ? value.trim().toLowerCase()
        : null,
    invalidMessage: "Enter the AWS region the key was created in.",
  };

  function renderWithSetting({
    hasSavedKey = false,
    savedValue = null,
    onSave = vi.fn().mockResolvedValue(true),
  }: {
    hasSavedKey?: boolean;
    savedValue?: string | null;
    onSave?: (value: string, setting?: string) => Promise<boolean>;
  } = {}) {
    render(
      <ApiKeyField
        label="Amazon Bedrock API Key"
        hasSavedKey={hasSavedKey}
        setting={{ ...regionSetting, savedValue }}
        onSave={onSave}
        onRemove={vi.fn().mockResolvedValue(true)}
      />,
    );
    return { onSave };
  }

  it("saves the key with its normalized setting", async () => {
    const user = userEvent.setup();
    const { onSave } = renderWithSetting();

    await user.type(screen.getByLabelText("Amazon Bedrock API Key"), "key-1");
    await user.type(screen.getByLabelText("AWS region"), "EU-West-2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("key-1", "eu-west-2");
  });

  it("explains an invalid setting instead of saving", async () => {
    const user = userEvent.setup();
    const { onSave } = renderWithSetting();

    await user.type(screen.getByLabelText("Amazon Bedrock API Key"), "key-1");
    await user.type(screen.getByLabelText("AWS region"), "London");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    const region = screen.getByLabelText("AWS region");
    expect(region).toHaveAttribute("aria-invalid", "true");
    expect(region).toHaveAccessibleDescription(
      "Enter the AWS region the key was created in.",
    );
  });

  it("saves only the setting onto an existing key", async () => {
    const user = userEvent.setup();
    const { onSave } = renderWithSetting({
      hasSavedKey: true,
      savedValue: "us-east-1",
    });
    const region = screen.getByLabelText("AWS region");
    expect(region).toHaveValue("us-east-1");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.clear(region);
    await user.type(region, "us-west-2");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("", "us-west-2");
  });

  it("needs a key before a setting alone can be saved", async () => {
    const user = userEvent.setup();
    renderWithSetting();

    await user.type(screen.getByLabelText("AWS region"), "us-east-1");

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
