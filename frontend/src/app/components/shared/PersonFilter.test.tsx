import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PersonFilter, distinctPeople, localPeople } from "./PersonFilter";

describe("distinctPeople", () => {
  it("lists each identified creator once, sorted by name", () => {
    expect(
      distinctPeople([
        { user_id: "b", display_name: "Zoe", profile_photo: null },
        { user_id: "a", display_name: " Ada ", profile_photo: "data:image/png;base64,AAAA" },
        { user_id: "b", display_name: "Zoe", profile_photo: null },
        { user_id: null, display_name: "Gone" },
      ]),
    ).toEqual([
      { user_id: "a", display_name: "Ada", email: null, profile_photo: "data:image/png;base64,AAAA" },
      { user_id: "b", display_name: "Zoe", email: null, profile_photo: null },
    ]);
  });
});

describe("PersonFilter", () => {
  it("searches a local list and selects a creator", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const people = distinctPeople([
      { user_id: "a", display_name: "Ada Lovelace" },
      { user_id: "b", display_name: "Grace Hopper" },
    ]);
    render(
      <PersonFilter
        label="Filter by creator"
        value={null}
        onChange={onChange}
        loadPeople={localPeople(people)}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Filter by creator" }));
    expect(await screen.findByRole("button", { name: /Ada Lovelace/ })).toBeVisible();
    await user.type(screen.getByRole("searchbox", { name: "Search people" }), "grace");
    expect(await screen.findByRole("button", { name: /Grace Hopper/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Ada Lovelace/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Grace Hopper/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(people[1]);
  });

  it("names the selected creator on the trigger", () => {
    render(
      <PersonFilter
        label="Filter by creator"
        selectedTitle={(name) => `Created by ${name}`}
        value={{ user_id: "a", display_name: "Ada", email: null, profile_photo: null }}
        onChange={vi.fn()}
        loadPeople={localPeople([])}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Filter by creator" });
    expect(trigger).toHaveAttribute("title", "Created by Ada");
    expect(trigger).toHaveAttribute("aria-pressed", "true");
  });
});
