import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import PersonalisationPage from "./page";

const { updatePersonalisation } = vi.hoisted(() => ({
  updatePersonalisation: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({
    profile: {
      jurisdiction: "Singapore",
      practiceSetting: "private_practice",
      professionalTitle: "Associate",
      practiceAreas: ["Litigation"],
    },
    updatePersonalisation,
  }),
}));

describe("PersonalisationPage", () => {
  beforeEach(() => {
    updatePersonalisation.mockReset();
    updatePersonalisation.mockResolvedValue(true);
  });

  it("updates the user's professional profile", async () => {
    const user = userEvent.setup();
    const { container } = render(withIntl(<PersonalisationPage />));

    expect(
      container.querySelectorAll('[data-slot="settings-row"]'),
    ).toHaveLength(4);

    await user.click(screen.getByRole("button", { name: "Título" }));
    await user.click(
      screen.getByRole("menuitemradio", { name: "General Counsel" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Ambiente profissional" }),
    );
    await user.click(
      screen.getByRole("menuitemradio", { name: "Jurídico interno (in-house)" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Jurisdição de atuação" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Australia" }));
    await user.click(screen.getByRole("button", { name: "Áreas de atuação" }));
    const practiceAreaOption = screen.getByRole("menuitemcheckbox", {
      name: "Data Protection and Privacy",
    });
    expect(practiceAreaOption).toHaveClass(
      "text-xs",
      "pl-3",
      "theme-dropdown-item",
    );
    expect(practiceAreaOption).not.toHaveClass("pl-8");
    await user.click(practiceAreaOption);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(updatePersonalisation).toHaveBeenCalledWith({
        jurisdiction: "Australia",
        practiceSetting: "in_house",
        professionalTitle: "General Counsel",
        practiceAreas: ["Litigation", "Data Protection and Privacy"],
      }),
    );
    expect(screen.getByText("Áreas de atuação").parentElement).toHaveTextContent(
      "Salvo",
    );
    expect(screen.queryByText("(optional)")).not.toBeInTheDocument();
  });

  it("still saves unrelated fields while an Other box is empty, and says why", async () => {
    const user = userEvent.setup();
    render(withIntl(<PersonalisationPage />));

    await user.click(screen.getByRole("button", { name: "Áreas de atuação" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Outra" }));
    await user.keyboard("{Escape}");
    expect(
      screen.getByText("Digite sua outra área de atuação"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Título" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Partner" }));
    await waitFor(() =>
      expect(updatePersonalisation).toHaveBeenCalledWith({
        jurisdiction: "Singapore",
        practiceSetting: "private_practice",
        professionalTitle: "Partner",
        // The half-finished Other box falls back to the stored areas.
        practiceAreas: ["Litigation"],
      }),
    );
  });

  it("does not drop an earlier pending edit when an Other box turns invalid", async () => {
    const user = userEvent.setup();
    const { unmount } = render(withIntl(<PersonalisationPage />));

    // Title edit is pending (still inside the debounce window)...
    await user.click(screen.getByRole("button", { name: "Título" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Partner" }));
    // ...when the user ticks "Other" and leaves it empty.
    await user.click(screen.getByRole("button", { name: "Áreas de atuação" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Outra" }));
    await user.keyboard("{Escape}");

    unmount(); // flush: the Title change must survive
    await waitFor(() =>
      expect(updatePersonalisation).toHaveBeenCalledWith({
        jurisdiction: "Singapore",
        practiceSetting: "private_practice",
        professionalTitle: "Partner",
        practiceAreas: ["Litigation"],
      }),
    );
  });

  it("flushes a save that is still inside its debounce window on unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(withIntl(<PersonalisationPage />));

    await user.click(screen.getByRole("button", { name: "Título" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Partner" }));
    expect(updatePersonalisation).not.toHaveBeenCalled();

    unmount();
    await waitFor(() =>
      expect(updatePersonalisation).toHaveBeenCalledWith(
        expect.objectContaining({ professionalTitle: "Partner" }),
      ),
    );
  });
});
