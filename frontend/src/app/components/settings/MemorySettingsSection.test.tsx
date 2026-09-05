import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUserMemory,
  setUserMemoryEnabled,
  wipeUserMemory,
  type MemoryCurrent,
} from "@/app/lib/mikeApi";
import { MemorySettingsSection } from "./MemorySettingsSection";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getUserMemory: vi.fn(),
  setUserMemoryEnabled: vi.fn(),
  wipeUserMemory: vi.fn(),
}));

function memory(overrides: Partial<MemoryCurrent> = {}): MemoryCurrent {
  return {
    enabled: true,
    content: "# Preferences",
    version: 2,
    hash: "hash-2",
    updated_at: "2026-09-05T10:00:00.000Z",
    updated_by: "user-1",
    source: "manual",
    status: "idle",
    ...overrides,
  };
}

describe("MemorySettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserMemory).mockResolvedValue(memory());
    vi.mocked(setUserMemoryEnabled).mockImplementation(async (enabled) =>
      memory({
        enabled,
        content: enabled ? "" : "",
        version: 0,
        hash: null,
        updated_at: null,
        updated_by: null,
        source: "settings",
      }),
    );
    vi.mocked(wipeUserMemory).mockResolvedValue(
      memory({
        content: "",
        // The CAS token remains monotonic even though no head exists.
        version: 3,
        hash: null,
        updated_at: null,
        updated_by: null,
        source: "wipe",
      }),
    );
  });

  it("labels the switch and requires destructive confirmation before disabling", async () => {
    const user = userEvent.setup();
    render(<MemorySettingsSection />);

    const toggle = await screen.findByRole("switch", {
      name: "App-wide memory",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveClass("focus-visible:ring-2");

    toggle.focus();
    expect(toggle).toHaveFocus();
    await user.click(toggle);

    expect(setUserMemoryEnabled).not.toHaveBeenCalled();
    expect(
      screen.getByText("Turn off and delete app-wide memory?"),
    ).toBeVisible();
    expect(
      screen.getByText(
        /permanently deletes memory\.md and its version history/i,
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(false),
    );
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("wipes history without disabling memory", async () => {
    const user = userEvent.setup();
    render(<MemorySettingsSection />);

    await user.click(
      await screen.findByRole("button", { name: "Wipe memory" }),
    );
    expect(wipeUserMemory).not.toHaveBeenCalled();

    const confirmButtons = screen.getAllByRole("button", {
      name: "Wipe memory",
    });
    await user.click(confirmButtons.at(-1)!);

    await waitFor(() => expect(wipeUserMemory).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("switch", { name: "App-wide memory" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Wipe memory" })).toBeDisabled();
  });

  it("enables a blank future-only memory without a destructive prompt", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      memory({
        enabled: false,
        content: "",
        version: 0,
        hash: null,
        updated_at: null,
        updated_by: null,
      }),
    );
    const user = userEvent.setup();
    render(<MemorySettingsSection />);

    await user.click(
      await screen.findByRole("switch", { name: "App-wide memory" }),
    );

    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(true),
    );
    expect(
      screen.queryByText("Turn off and delete app-wide memory?"),
    ).not.toBeInTheDocument();
  });

  it("links to the review page and exposes its settings anchor", async () => {
    const { container } = render(<MemorySettingsSection />);

    expect(
      await screen.findByRole("link", { name: "View memory" }),
    ).toHaveAttribute("href", "/memory");
    expect(container.querySelector("#memory")).not.toBeNull();
  });

  it("shows automatic-review status in plain text", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(memory({ status: "scheduled" }));

    render(<MemorySettingsSection />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "On · review scheduled",
    );
  });
});
