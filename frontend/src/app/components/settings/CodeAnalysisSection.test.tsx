import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCodeAnalysisSettings,
  updateCodeAnalysisSettings,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { CodeAnalysisSection } from "./CodeAnalysisSection";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getCodeAnalysisSettings: vi.fn(),
  updateCodeAnalysisSettings: vi.fn(),
}));

vi.mock("@/app/lib/userFacingError", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/userFacingError")>()),
  notifyError: vi.fn(),
}));

const toggle = () =>
  screen.getByRole("switch", { name: "Run Python for data analysis" });

describe("CodeAnalysisSection", () => {
  beforeEach(() => {
    vi.mocked(updateCodeAnalysisSettings).mockReset();
    vi.mocked(notifyError).mockReset();
  });

  it("switches on at once and puts the switch back with a notice when the save fails", async () => {
    vi.mocked(getCodeAnalysisSettings).mockResolvedValue({ enabled: false, available: true });
    const failure = new Error("boom");
    let reject!: (error: Error) => void;
    vi.mocked(updateCodeAnalysisSettings).mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    render(<CodeAnalysisSection />);
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(toggle());

    expect(updateCodeAnalysisSettings).toHaveBeenCalledWith(true);
    expect(toggle()).toHaveAttribute("aria-checked", "true");
    reject(failure);
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(failure, expect.anything()),
    );
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("says the server has it turned off and keeps the switch disabled", async () => {
    vi.mocked(getCodeAnalysisSettings).mockResolvedValue({ enabled: false, available: false });
    render(<CodeAnalysisSection />);

    expect(
      await screen.findByText("Code analysis is turned off on this server."),
    ).toBeInTheDocument();
    expect(toggle()).toBeDisabled();
  });
});
