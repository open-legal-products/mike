import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AccessVisibilityField } from "./AccessVisibilityField";

const field = () => screen.getByRole("group", { name: "Organisational Access" });
const option = (name: "Private" | "Public") =>
    within(field()).getByRole("button", { name });

describe("AccessVisibilityField", () => {
    it("is titled Organisational Access and offers Private then Public as pill options", () => {
        render(
            <AccessVisibilityField
                visibility="private"
                onChange={vi.fn()}
                organizationName="Elite Law LLP"
                resourceNoun="project"
            />,
        );
        expect(
            within(field())
                .getAllByRole("button")
                .map((button) => button.textContent),
        ).toEqual(["Private", "Public"]);
        // A choice between two, not a switch.
        expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    });

    it("marks Private as chosen for a private item, and says who can open it", () => {
        render(
            <AccessVisibilityField
                visibility="private"
                onChange={vi.fn()}
                organizationName="Elite Law LLP"
                resourceNoun="project"
            />,
        );
        expect(option("Private")).toHaveAttribute("aria-pressed", "true");
        expect(option("Public")).toHaveAttribute("aria-pressed", "false");
        expect(field()).toHaveAccessibleDescription(
            "Only the people you share this project with can open it.",
        );
    });

    it("marks Public as chosen for a public item, and names the organisation it is open to", () => {
        render(
            <AccessVisibilityField
                visibility="organization"
                onChange={vi.fn()}
                organizationName="Elite Law LLP"
                resourceNoun="workflow"
            />,
        );
        expect(option("Public")).toHaveAttribute("aria-pressed", "true");
        expect(option("Private")).toHaveAttribute("aria-pressed", "false");
        expect(field()).toHaveAccessibleDescription(
            "Everyone in Elite Law LLP can open and edit this workflow.",
        );
    });

    it("sets what the choice means beside the toggle, not under it", () => {
        const { container } = render(
            <AccessVisibilityField
                visibility="private"
                onChange={vi.fn()}
                organizationName="Elite Law LLP"
                resourceNoun="project"
            />,
        );
        const description = container.querySelector(
            '[data-slot="access-visibility-description"]',
        )!;
        const row = description.parentElement!;
        // One row holding the toggle and then the text...
        expect(row).toHaveClass("flex", "items-center");
        expect(row.firstElementChild).toContainElement(option("Private"));
        expect(row.lastElementChild).toBe(description);
        // ...which wraps onto its own line only when there is no room.
        expect(row).toHaveClass("flex-wrap");
        expect(description).toHaveClass("min-w-0");
        expect(description).not.toHaveClass("mt-1.5");
    });

    it("reports the option that was chosen", () => {
        const onChange = vi.fn();
        render(
            <AccessVisibilityField
                visibility="private"
                onChange={onChange}
                resourceNoun="project"
            />,
        );
        fireEvent.click(option("Public"));
        expect(onChange).toHaveBeenLastCalledWith("organization");
        fireEvent.click(option("Private"));
        expect(onChange).toHaveBeenLastCalledWith("private");
    });

    it("still reads sensibly before the organisation's name is known", () => {
        render(
            <AccessVisibilityField
                visibility="organization"
                onChange={vi.fn()}
                resourceNoun="project"
            />,
        );
        expect(
            screen.getByText(
                "Everyone in the organisation can open and edit this project.",
            ),
        ).toBeInTheDocument();
    });

    it("can be shown without being changeable", () => {
        const onChange = vi.fn();
        render(
            <AccessVisibilityField
                visibility="organization"
                onChange={onChange}
                resourceNoun="workflow"
                disabled
            />,
        );
        expect(option("Private")).toBeDisabled();
        expect(option("Public")).toBeDisabled();
        fireEvent.click(option("Private"));
        expect(onChange).not.toHaveBeenCalled();
    });
});
