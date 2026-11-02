import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UserAvatar, avatarColour, avatarInitials } from "./user-avatar";

const PHOTO = "data:image/png;base64,iVBORw0KGgo=";
describe("UserAvatar", () => {
  it("uses the same background for normalized email regardless of display name", () => {
    expect(avatarColour(" Alex@Example.com ", "Alex")).toBe(avatarColour("alex@example.com", "Alex Morgan"));
    expect(new Set(["alex", "sam", "jane", "robin"].map((name) => avatarColour(`${name}@example.com`))).size).toBeGreaterThan(1);
  });
  it("falls back to readable initials on a coloured background", () => {
    render(<UserAvatar name="Alex Morgan" email="alex@example.com" />);
    expect(screen.getByRole("img", { name: "Alex Morgan" })).toHaveClass("text-white", avatarColour("alex@example.com"));
    expect(screen.getByText("AM")).toBeInTheDocument();
    expect(avatarInitials(null, "jane.smith@example.com")).toBe("JS");
    expect(avatarInitials("李 明")).toBe("李明");
    expect(avatarInitials()).toBe("?");
  });
  it("shows a photo, recovers from a broken image, and accepts a replacement", () => {
    const { container, rerender } = render(<UserAvatar photo={PHOTO} name="Alex Morgan" />);
    expect(container.querySelector("img")).toHaveAttribute("src", PHOTO);
    expect(screen.queryByText("AM")).not.toBeInTheDocument();
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByText("AM")).toBeInTheDocument();
    rerender(<UserAvatar photo={`${PHOTO}NEW`} name="Alex Morgan" />);
    expect(container.querySelector("img")).toHaveAttribute("src", `${PHOTO}NEW`);
    rerender(<UserAvatar photo={null} name="Alex Morgan" />);
    expect(container.querySelector("img")).toBeNull();
  });
  it("never loads remote or executable image sources", () => {
    const { container } = render(<UserAvatar photo="data:image/svg+xml;base64,PHN2Zy8+" name="Alex" />);
    expect(container.querySelector("img")).toBeNull();
  });
});
