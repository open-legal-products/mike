import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FieldLabel, FormTextInput } from "./form-field";

describe("FormTextInput", () => {
    it("replaces the suppressed outline with a focus ring", () => {
        render(<FormTextInput aria-label="Name" />);
        expect(screen.getByRole("textbox", { name: "Name" })).toHaveClass(
            "liquid-glass-subtle",
            "focus-visible:ring-2",
        );
    });

    it("rings the minimal variant for keyboard navigation only", () => {
        render(<FormTextInput variant="minimal" aria-label="Title" />);
        expect(screen.getByRole("textbox", { name: "Title" })).toHaveClass(
            "focus-visible:ring-2",
            "keyboard-focus-ring",
        );
    });
});

describe("FieldLabel", () => {
    it("associates a label with its control", () => {
        render(
            <>
                <FieldLabel htmlFor="cm">Matter number</FieldLabel>
                <input id="cm" />
            </>,
        );
        expect(
            screen.getByRole("textbox", { name: "Matter number" }),
        ).toBeInTheDocument();
    });

    it("keeps forwarded props when rendered as a non-label element", () => {
        render(
            <>
                <FieldLabel as="span" id="group-name">
                    Documents
                </FieldLabel>
                <div role="group" aria-labelledby="group-name" />
            </>,
        );
        expect(
            screen.getByRole("group", { name: "Documents" }),
        ).toBeInTheDocument();
    });
});
