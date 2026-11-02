import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OnboardingPracticePage from "./page";

const { push, replace, updatePersonalisation } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  updatePersonalisation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "alex@example.com" },
    authLoading: false,
  }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({
    profile: {
      jurisdiction: null,
      practiceSetting: null,
      professionalTitle: null,
      practiceAreas: [],
    },
    loading: false,
    updatePersonalisation,
  }),
}));

vi.mock("@/app/components/site-logo", () => ({
  SiteLogo: () => <div>Mike</div>,
}));

describe("OnboardingPracticePage", () => {
  beforeEach(() => {
    push.mockReset();
    replace.mockReset();
    updatePersonalisation.mockReset();
    updatePersonalisation.mockResolvedValue(true);
  });

  it("saves practice details before advancing to invitations", async () => {
    const user = userEvent.setup();
    const { container } = render(<OnboardingPracticePage />);

    expect(screen.getByText("Step 2 of 4")).toBeVisible();
    expect(
      container.querySelector('[data-slot="settings-row"]'),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Jurisdiction of practice",
      }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Other" }));
    await user.type(
      screen.getByRole("textbox", { name: "Other jurisdiction" }),
      "England and Wales",
    );
    await user.click(screen.getByRole("button", { name: "Title" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: "Senior Associate" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Professional setting" }),
    );
    await user.click(
      screen.getByRole("menuitemradio", { name: "Private practice" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Select practice areas" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", { name: "Litigation" }),
    );
    await user.click(
      screen.getByRole("menuitemcheckbox", {
        name: "Data Protection and Privacy",
      }),
    );
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(updatePersonalisation).toHaveBeenCalledWith({
        jurisdiction: "England and Wales",
        practiceSetting: "private_practice",
        professionalTitle: "Senior Associate",
        practiceAreas: ["Litigation", "Data Protection and Privacy"],
      }),
    );
    expect(push).toHaveBeenCalledWith("/onboarding/invitations");
  });

  it("requires free text when Other is selected", async () => {
    const user = userEvent.setup();
    render(<OnboardingPracticePage />);

    await user.click(
      screen.getByRole("button", {
        name: "Jurisdiction of practice",
      }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Australia" }));
    await user.click(
      screen.getByRole("button", { name: "Professional setting" }),
    );
    await user.click(
      screen.getByRole("menuitemradio", {
        name: "Not a practising attorney",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Select practice areas" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Other" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter your other practice area",
    );
    expect(updatePersonalisation).not.toHaveBeenCalled();
  });

  it("allows personalisation to be skipped", async () => {
    const user = userEvent.setup();
    render(<OnboardingPracticePage />);

    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(updatePersonalisation).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/onboarding/invitations");
  });

  it("stays on practice details when saving fails, leaving the report to the notice", async () => {
    // updatePersonalisation raises the notice; the form must not repeat it.
    updatePersonalisation.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<OnboardingPracticePage />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    expect(updatePersonalisation).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

});
