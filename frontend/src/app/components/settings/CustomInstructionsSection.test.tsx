import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  getCustomInstructions,
  updateCustomInstructions,
} from "@/app/lib/mikeApi";
import {
  CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  CustomInstructionsSection,
} from "./CustomInstructionsSection";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getCustomInstructions: vi.fn(),
  updateCustomInstructions: vi.fn(),
}));

function editor() {
  return screen.findByRole("textbox", { name: "Custom instructions" });
}

describe("CustomInstructionsSection", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(getCustomInstructions).mockReset();
    vi.mocked(updateCustomInstructions).mockReset();
    vi.mocked(getCustomInstructions).mockResolvedValue({
      content: "Use British spelling.",
    });
    vi.mocked(updateCustomInstructions).mockImplementation(async (content) => ({
      content,
    }));
  });

  it("is a plain text area on the flat glass surface", async () => {
    render(<CustomInstructionsSection />);

    const field = await editor();
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveClass("liquid-glass-flat", "rounded-xl");
    expect(field).not.toHaveClass("liquid-glass-subtle");
  });

  it("shows a skeleton while loading, then the saved instructions", async () => {
    render(<CustomInstructionsSection />);

    expect(
      screen.getByLabelText("Loading custom instructions"),
    ).toBeInTheDocument();
    expect(await editor()).toHaveValue("Use British spelling.");
    expect(updateCustomInstructions).not.toHaveBeenCalled();
  });

  it("autosaves edits after a pause and reports when saved", async () => {
    render(<CustomInstructionsSection />);
    const textbox = await editor();

    vi.useFakeTimers();
    fireEvent.change(textbox, { target: { value: "Be concise." } });
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(updateCustomInstructions).toHaveBeenCalledTimes(1);
    expect(updateCustomInstructions).toHaveBeenCalledWith("Be concise.");
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("coalesces rapid edits into one save of the latest draft", async () => {
    render(<CustomInstructionsSection />);
    const textbox = await editor();

    vi.useFakeTimers();
    fireEvent.change(textbox, { target: { value: "B" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    fireEvent.change(textbox, { target: { value: "Be brief." } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(updateCustomInstructions).toHaveBeenCalledTimes(1);
    expect(updateCustomInstructions).toHaveBeenCalledWith("Be brief.");
  });

  it("does not save a change that is only trailing whitespace", async () => {
    render(<CustomInstructionsSection />);
    const textbox = await editor();

    vi.useFakeTimers();
    fireEvent.change(textbox, {
      target: { value: "Use British spelling.\n\n" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(updateCustomInstructions).not.toHaveBeenCalled();
  });

  it("does not save over-long instructions and explains why", async () => {
    render(<CustomInstructionsSection />);
    const textbox = await editor();

    vi.useFakeTimers();
    fireEvent.change(textbox, {
      target: { value: "x".repeat(CUSTOM_INSTRUCTIONS_MAX_LENGTH + 1) },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(updateCustomInstructions).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /8,000 characters or fewer/,
    );
  });

  it("keeps the draft and offers a retry when a save fails", async () => {
    vi.mocked(updateCustomInstructions).mockRejectedValueOnce(
      new MikeApiError({ message: "boom", status: 500 }),
    );
    render(<CustomInstructionsSection />);
    const textbox = await editor();

    fireEvent.change(textbox, { target: { value: "Be concise." } });
    expect(
      await screen.findByText(
        "Custom instructions could not be saved. Your draft has been kept.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    expect(textbox).toHaveValue("Be concise.");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(
      () => expect(updateCustomInstructions).toHaveBeenCalledTimes(2),
      { timeout: 3000 },
    );
    expect(updateCustomInstructions).toHaveBeenLastCalledWith("Be concise.");
  });

  it("shows a retry when loading fails", async () => {
    vi.mocked(getCustomInstructions).mockRejectedValueOnce(new Error("down"));
    render(<CustomInstructionsSection />);

    expect(
      await screen.findByText(
        "Could not load your custom instructions. Please try again.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await editor()).toHaveValue("Use British spelling.");
  });
});
