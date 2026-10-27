import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextCardUI } from "./TextCardUI";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TextCardUI", () => {
  it("displays literal, selectable text without an editor and copies it exactly", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const text = "Dear Alex,\n\n  <b>Keep this literal</b> and **this too**.\n";
    const { container } = render(
      <TextCardUI title="Draft email" text={text} />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(container.querySelector("[contenteditable], b")).toBeNull();
    expect(container.querySelector(".whitespace-pre-wrap")?.textContent).toBe(
      text,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy Draft email" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied Draft email" }),
      ).toBeVisible(),
    );
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("clears the copied indicator after two seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    render(<TextCardUI title="Clause" text="Copy me" />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy Clause" }));
    });
    expect(screen.getByRole("button", { name: "Copied Clause" })).toBeVisible();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: "Copy Clause" })).toBeVisible();
  });

  it("keeps the text available for manual copying when clipboard access fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error("Permission denied")),
      },
    });
    render(<TextCardUI title="Clause" text="Copy me" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy Clause" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Select the text and copy it manually",
    );
    expect(screen.getByText("Copy me")).toBeVisible();
    expect(screen.queryByText("Permission denied")).toBeNull();
  });
});
