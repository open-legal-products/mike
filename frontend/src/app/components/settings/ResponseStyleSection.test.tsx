import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getResponseStyle,
  updateResponseStyle,
  type ResponseStyle,
} from "@/app/lib/mikeApi";
import { ResponseStyleSection } from "./ResponseStyleSection";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getResponseStyle: vi.fn(),
  updateResponseStyle: vi.fn(),
}));

const stored: ResponseStyle = {
  verbosity: "balanced",
  formatting: "balanced",
  tone: "balanced",
  language: "auto",
};

function trigger(name: string) {
  return screen.getByRole("button", { name });
}

async function choose(setting: string, option: string) {
  // Radix opens on pointerdown, not click.
  fireEvent.pointerDown(
    trigger(setting),
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
  );
  fireEvent.click(await screen.findByRole("menuitemradio", { name: option }));
}

describe("ResponseStyleSection", () => {
  beforeEach(() => {
    vi.mocked(getResponseStyle).mockReset();
    vi.mocked(updateResponseStyle).mockReset();
    vi.mocked(getResponseStyle).mockResolvedValue({
      ...stored,
      tone: "plain",
    });
    vi.mocked(updateResponseStyle).mockImplementation(async (update) => ({
      ...stored,
      ...update,
    }));
  });

  it("shows each saved setting in its selector", async () => {
    render(<ResponseStyleSection />);

    await waitFor(() => expect(trigger("Verbosity")).toHaveTextContent("Balanced"));
    expect(trigger("Headers and Lists")).toHaveTextContent("Balanced");
    expect(trigger("Tone")).toHaveTextContent("Plain and Simple");
    expect(
      screen.getByText(/everyday words, with legal terms explained/),
    ).toBeInTheDocument();
  });

  it("offers English variants and other languages, and saves the choice", async () => {
    render(<ResponseStyleSection />);
    await waitFor(() => expect(trigger("Language")).toBeEnabled());
    expect(trigger("Language")).toHaveTextContent("Automatic");
    expect(
      screen.getByText("Mike replies in the language you write in."),
    ).toBeInTheDocument();

    fireEvent.pointerDown(
      trigger("Language"),
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    const options = (await screen.findAllByRole("menuitemradio")).map(
      (option) => option.textContent,
    );
    expect(options.slice(0, 3)).toEqual([
      "Automatic",
      "English (US)",
      "English (UK)",
    ]);
    expect(options).toEqual(
      expect.arrayContaining(["French", "Spanish", "Chinese (Simplified)"]),
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "English (UK)" }));

    expect(updateResponseStyle).toHaveBeenCalledWith({ language: "en-GB" });
    await waitFor(() =>
      expect(trigger("Language")).toHaveTextContent("English (UK)"),
    );
    expect(screen.getByText("Mike replies in English (UK).")).toBeInTheDocument();
  });

  it("saves only the setting that changed", async () => {
    render(<ResponseStyleSection />);
    await waitFor(() => expect(trigger("Headers and Lists")).toBeEnabled());

    await choose("Headers and Lists", "More");

    expect(updateResponseStyle).toHaveBeenCalledWith({ formatting: "more" });
    await waitFor(() =>
      expect(trigger("Headers and Lists")).toHaveTextContent("More"),
    );
    expect(trigger("Verbosity")).toHaveTextContent("Balanced");
  });

  it("reverts and explains a failed save on that setting only", async () => {
    vi.mocked(updateResponseStyle).mockRejectedValue(new Error("boom"));
    render(<ResponseStyleSection />);
    await waitFor(() => expect(trigger("Verbosity")).toBeEnabled());

    await choose("Verbosity", "Detailed");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not be saved/i,
    );
    expect(trigger("Verbosity")).toHaveTextContent("Balanced");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("offers a retry when loading fails", async () => {
    vi.mocked(getResponseStyle).mockRejectedValueOnce(new Error("boom"));
    render(<ResponseStyleSection />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => expect(trigger("Tone")).toHaveTextContent("Plain and Simple"));
  });
});
