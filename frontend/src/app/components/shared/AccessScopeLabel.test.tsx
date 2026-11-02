import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccessScopeLabel } from "./AccessScopeLabel";

describe("AccessScopeLabel", () => {
  it.each([
    ["organization", "Public"],
    ["private", "Private"],
    ["shared", "Private (Shared)"],
  ] as const)("labels the %s access scope %s", (scope, label) => {
    const { container } = render(<AccessScopeLabel scope={scope} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("defaults to Private when no scope is known", () => {
    // Fail closed: an item whose scope did not arrive must not read as open.
    render(<AccessScopeLabel />);
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("says Public, and names the organisation only on hover", () => {
    render(
      <AccessScopeLabel
        scope="organization"
        organizationName="Elite Law LLP"
      />,
    );

    expect(screen.getByText("Public")).toBeInTheDocument();
    // The column says the same thing on every public row; whose "everyone"
    // it is belongs in the detail.
    expect(screen.queryByText("Elite Law LLP")).not.toBeInTheDocument();
    expect(
      screen.getByTitle("Shared with everyone in Elite Law LLP"),
    ).toBeVisible();
  });

  it.each([
    [0, "1 user"],
    [3, "4 users"],
  ] as const)(
    "says Private (Shared) for a direct grant count of %i, with %s on hover",
    (count, people) => {
      render(<AccessScopeLabel scope="shared" directGrantCount={count} />);

      expect(screen.getByText("Private (Shared)")).toBeInTheDocument();
      expect(screen.queryByText(people)).not.toBeInTheDocument();
      expect(screen.getByTitle(`Shared with ${people}`)).toBeVisible();
    },
  );

  it("describes a shared item whose count is unknown", () => {
    render(<AccessScopeLabel scope="shared" />);
    expect(screen.getByTitle("Shared with individuals")).toBeVisible();
  });
});
