import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { SettingsHeading } from "./SettingsHeading";
import { SettingsRow } from "./SettingsRow";

describe("settings primitives", () => {
  it("renders a consistently styled settings heading", () => {
    render(<SettingsHeading>Appearance</SettingsHeading>);

    expect(
      screen.getByRole("heading", { name: "Appearance", level: 2 }),
    ).toHaveClass("font-serif", "text-2xl", "font-medium", "text-gray-900");
  });

  it("supports the danger heading tone", () => {
    render(<SettingsHeading tone="danger">Danger Zone</SettingsHeading>);

    expect(screen.getByRole("heading", { name: "Danger Zone" })).toHaveClass(
      "text-red-600",
    );
  });

  it("composes card rows with shared spacing and dividers", () => {
    render(
      <GlassCardUI>
        <SettingsRow>
          <span>Setting</span>
          <button type="button">Action</button>
        </SettingsRow>
      </GlassCardUI>,
    );

    expect(screen.getByText("Setting").parentElement).toHaveClass(
      "sm:flex-row",
      "border-t",
      "first:border-t-0",
      "px-4",
      "py-5",
    );
  });

  it("keeps stacked rows vertical at every breakpoint", () => {
    render(
      <SettingsRow layout="stacked">
        <span>Field</span>
        <input aria-label="Field" />
      </SettingsRow>,
    );

    expect(screen.getByText("Field").parentElement).not.toHaveClass(
      "sm:flex-row",
    );
  });
});
