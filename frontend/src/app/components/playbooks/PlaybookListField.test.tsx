import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlaybookListField } from "./PlaybookListField";
import { PLAYBOOK_JURISDICTION_OPTIONS } from "./playbookJurisdictions";

function Jurisdictions({ initial }: { initial: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PlaybookListField
        label="Jurisdictions"
        value={value}
        onChange={setValue}
        options={PLAYBOOK_JURISDICTION_OPTIONS}
      />
      <output aria-label="Saved">{value.join("|")}</output>
    </>
  );
}

describe("PlaybookListField with options", () => {
  it("adds and removes chosen entries alongside typed ones", async () => {
    const user = userEvent.setup();
    render(<Jurisdictions initial={["Hong Kong SAR", "new york"]} />);

    await user.click(
      screen.getByRole("button", { name: "Choose jurisdictions" }),
    );
    // Typed entries match their option whatever the case.
    expect(
      screen.getByRole("menuitemcheckbox", { name: "New York" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "England and Wales" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "New York" }));

    // The menu stays open, and an entry not in the list is kept.
    expect(
      screen.getByRole("menuitemcheckbox", { name: "England and Wales" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Jurisdictions")).toHaveValue(
      "Hong Kong SAR, England and Wales",
    );
    expect(screen.getByLabelText("Saved")).toHaveTextContent(
      "Hong Kong SAR|England and Wales",
    );
  });

  it("keeps a state apart from a country of the same name", () => {
    const georgias = PLAYBOOK_JURISDICTION_OPTIONS.filter(
      (option) => option.label === "Georgia",
    );
    expect(georgias.map((option) => option.value)).toEqual([
      "Georgia",
      "Georgia (US)",
    ]);
    expect(
      new Set(PLAYBOOK_JURISDICTION_OPTIONS.map((option) => option.value)).size,
    ).toBe(PLAYBOOK_JURISDICTION_OPTIONS.length);
  });
});
