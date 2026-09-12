import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import OnboardingPracticePage from "./page";

const { push, replace, completeOnboarding } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  completeOnboarding: vi.fn(),
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
    completeOnboarding,
  }),
}));

vi.mock("@/app/components/site-logo", () => ({
  SiteLogo: () => <div>Mike</div>,
}));

describe("OnboardingPracticePage", () => {
  beforeEach(() => {
    push.mockReset();
    replace.mockReset();
    completeOnboarding.mockReset();
    completeOnboarding.mockResolvedValue(true);
  });

  it("saves a country and multiple practice areas", async () => {
    const user = userEvent.setup();
    const { container } = render(withIntl(<OnboardingPracticePage />));

    expect(
      container.querySelector('[data-slot="settings-row"]'),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Jurisdição de atuação",
      }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Outra" }));
    await user.type(
      screen.getByRole("textbox", { name: "Outra jurisdição" }),
      "England and Wales",
    );
    await user.click(screen.getByRole("button", { name: "Título" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: "Senior Associate" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Ambiente profissional" }),
    );
    await user.click(
      screen.getByRole("menuitemradio", { name: "Advocacia privada" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Selecione áreas de atuação" }),
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
    await user.click(screen.getByRole("button", { name: "Concluir" }));

    await waitFor(() =>
      expect(completeOnboarding).toHaveBeenCalledWith({
        jurisdiction: "England and Wales",
        practiceSetting: "private_practice",
        professionalTitle: "Senior Associate",
        practiceAreas: ["Litigation", "Data Protection and Privacy"],
      }),
    );
    expect(replace).toHaveBeenCalledWith("/assistant");
  });

  it("requires free text when Other is selected", async () => {
    const user = userEvent.setup();
    render(withIntl(<OnboardingPracticePage />));

    await user.click(
      screen.getByRole("button", {
        name: "Jurisdição de atuação",
      }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Australia" }));
    await user.click(
      screen.getByRole("button", { name: "Ambiente profissional" }),
    );
    await user.click(
      screen.getByRole("menuitemradio", {
        name: "Não exerce a advocacia atualmente",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Selecione áreas de atuação" }),
    );
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Outra" }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Concluir" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Digite sua outra área de atuação",
    );
    expect(completeOnboarding).not.toHaveBeenCalled();
  });

  it("allows personalisation to be skipped", async () => {
    const user = userEvent.setup();
    render(withIntl(<OnboardingPracticePage />));

    await user.click(screen.getByRole("button", { name: "Pular" }));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledWith({}));
    expect(replace).toHaveBeenCalledWith("/assistant");
  });
});
