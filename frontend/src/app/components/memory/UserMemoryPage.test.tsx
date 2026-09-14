import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  getUserMemory,
  setUserMemoryEnabled,
  updateUserMemory,
  type MemoryCurrent,
} from "@/app/lib/mikeApi";
import { UserMemoryPage } from "./UserMemoryPage";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getUserMemory: vi.fn(),
  setUserMemoryEnabled: vi.fn(),
  updateUserMemory: vi.fn(),
}));

const profileState = vi.hoisted(() => ({
  projectMemoryDefault: true,
  updateProjectMemoryDefault: vi.fn(),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({
    profile: { projectMemoryDefault: profileState.projectMemoryDefault },
    updateProjectMemoryDefault: profileState.updateProjectMemoryDefault,
  }),
}));

vi.mock("@/app/components/ui/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    ariaLabel,
    readOnly,
    suspended,
  }: {
    value: string;
    onChange?: (value: string) => void;
    ariaLabel?: string;
    readOnly?: boolean;
    suspended?: boolean;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly || suspended}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

function current(overrides: Partial<MemoryCurrent> = {}): MemoryCurrent {
  return {
    enabled: true,
    content: "# Preferences",
    revision: 2,
    hash: "hash-2",
    updated_at: "2026-09-05T10:00:00.000Z",
    updated_by: "user-1",
    source: "manual",
    status: "idle",
    ...overrides,
  };
}

describe("UserMemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    profileState.projectMemoryDefault = true;
    profileState.updateProjectMemoryDefault.mockResolvedValue(undefined);
    vi.mocked(getUserMemory).mockResolvedValue(current());
    vi.mocked(updateUserMemory).mockImplementation(async (content) =>
      current({ content, revision: 3, hash: "hash-3" }),
    );
    vi.mocked(setUserMemoryEnabled).mockImplementation(async (enabled) =>
      current({
        enabled,
        content: "",
        revision: 3,
        hash: null,
        updated_at: null,
        updated_by: null,
        source: "settings",
      }),
    );
  });

  it("loads the current file independently and autosaves editor changes", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    const toggle = screen.getByRole("switch", { name: "App-wide memory" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveClass("focus-visible:ring-2");
    expect(editor).toHaveValue("# Preferences");
    // A quiet, up-to-date file reports nothing: no timestamp, no source.
    expect(screen.queryByText(/Last updated/)).toBeNull();
    expect(screen.queryByText(/Manual edit/)).toBeNull();

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    await user.clear(editor);
    await user.type(editor, "# Saved");
    expect(updateUserMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Saving…")).toBeVisible();

    await waitFor(
      () => expect(updateUserMemory).toHaveBeenCalledWith("# Saved", 2),
      { timeout: 2000 },
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("pauses curator polling while the tab is hidden and backs off while nothing changes", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(current({ status: "processing" }));
    render(<UserMemoryPage />);
    await screen.findByRole("textbox", { name: "App-wide memory" });
    expect(getUserMemory).toHaveBeenCalledTimes(1);

    const visibility = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "visibilityState",
    );
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      fireEvent(document, new Event("visibilitychange"));
    };
    vi.useFakeTimers();
    try {
      // The first timer was armed on real timers; a visibility round trip
      // re-arms it on the fake clock.
      await act(async () => {
        setVisibility("hidden");
      });
      await act(async () => {
        setVisibility("visible");
      });
      // First poll after 3 s; the file is unchanged so the next wait doubles.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(getUserMemory).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(getUserMemory).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(getUserMemory).toHaveBeenCalledTimes(3);

      // A hidden tab has nobody to show the status to: no requests at all.
      await act(async () => {
        setVisibility("hidden");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(getUserMemory).toHaveBeenCalledTimes(3);

      // Coming back resets the backoff so the status is fresh quickly.
      await act(async () => {
        setVisibility("visible");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(getUserMemory).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
      if (visibility) {
        Object.defineProperty(document, "visibilityState", visibility);
      } else {
        delete (document as { visibilityState?: unknown }).visibilityState;
      }
    }
  });

  it("explains a save refused because memory was turned off meanwhile", async () => {
    vi.mocked(updateUserMemory).mockRejectedValueOnce(
      new MikeApiError({
        status: 409,
        code: "memory_disabled",
        message: "Enable memory before editing it.",
      }),
    );
    const user = userEvent.setup();
    render(<UserMemoryPage />);
    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    // The refetch after the refusal reports the file as disabled.
    vi.mocked(getUserMemory).mockResolvedValue(
      current({ enabled: false, content: "", hash: null, revision: 5 }),
    );
    await user.clear(editor);
    await user.type(editor, "# Lost");

    expect(
      await screen.findByText(
        "Memory was turned off while you were editing, so your changes were not saved.",
        {},
        { timeout: 2000 },
      ),
    ).toBeVisible();
    // The toggle stops claiming memory is on, and nothing is retried.
    expect(
      screen.getByRole("switch", { name: "App-wide memory" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(updateUserMemory).toHaveBeenCalledTimes(1);
  });

  it("adopts server-normalized Markdown without repeatedly saving it", async () => {
    vi.mocked(updateUserMemory).mockResolvedValue(
      current({ content: "# Normalized", revision: 3, hash: "hash-3" }),
    );
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await screen.findByRole("switch", { name: "App-wide memory" });

    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "# Normalized " } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(updateUserMemory).toHaveBeenCalledOnce();
      expect(editor).toHaveValue("# Normalized");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(updateUserMemory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes saves without locking or overwriting newer editor input", async () => {
    let resolveSave!: (value: MemoryCurrent) => void;
    vi.mocked(updateUserMemory).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Pending");

    await waitFor(
      () => expect(updateUserMemory).toHaveBeenCalledWith("# Pending", 2),
      { timeout: 2000 },
    );
    expect(editor).not.toHaveAttribute("readonly");
    expect(
      screen.getByRole("switch", { name: "App-wide memory" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    await user.type(editor, " and newer");
    expect(editor).toHaveValue("# Pending and newer");

    await act(async () => {
      resolveSave(
        current({ content: "# Pending", revision: 3, hash: "hash-3" }),
      );
    });
    expect(editor).toHaveValue("# Pending and newer");
    await waitFor(
      () =>
        expect(updateUserMemory).toHaveBeenLastCalledWith(
          "# Pending and newer",
          3,
        ),
      { timeout: 2000 },
    );
  });

  it("preserves a stale draft and requires an explicit conflict choice", async () => {
    const latest = current({
      content: "# Automatic update",
      revision: 3,
      hash: "hash-3",
    });
    vi.mocked(getUserMemory)
      .mockResolvedValueOnce(current())
      .mockResolvedValueOnce(latest);
    vi.mocked(updateUserMemory)
      .mockRejectedValueOnce(
        new MikeApiError({
          status: 409,
          code: "memory_revision_conflict",
          message: "Memory changed",
        }),
      )
      .mockResolvedValueOnce(
        current({ content: "# My draft", revision: 4, hash: "hash-4" }),
      );
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# My draft");

    expect(
      await screen.findByText(
        "Memory changed while you were editing",
        {},
        {
          timeout: 2000,
        },
      ),
    ).toBeVisible();
    expect(editor).toHaveValue("# My draft");

    await user.click(screen.getByRole("button", { name: "Keep my draft" }));

    await waitFor(
      () => expect(updateUserMemory).toHaveBeenLastCalledWith("# My draft", 3),
      { timeout: 2000 },
    );
  });

  it("keeps a failed autosave draft and lets the user retry it", async () => {
    vi.mocked(updateUserMemory).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Still here");

    expect(
      await screen.findByText(
        "Memory could not be saved. Your draft has been kept.",
        {},
        { timeout: 2000 },
      ),
    ).toBeVisible();
    expect(editor).toHaveValue("# Still here");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(
      () =>
        expect(updateUserMemory).toHaveBeenLastCalledWith("# Still here", 2),
      { timeout: 2000 },
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("flushes a pending autosave when the settings page unmounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Save on leave");
    expect(updateUserMemory).not.toHaveBeenCalled();

    unmount();

    await waitFor(() =>
      expect(updateUserMemory).toHaveBeenCalledWith("# Save on leave", 2),
    );
  });

  it("enables memory from the same settings page and reveals a blank editor", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      current({
        enabled: false,
        content: "",
        revision: 0,
        hash: null,
        updated_at: null,
        updated_by: null,
      }),
    );
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const toggle = await screen.findByRole("switch", {
      name: "App-wide memory",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.queryByRole("textbox", { name: "App-wide memory" }),
    ).not.toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(true),
    );
    expect(
      await screen.findByRole("textbox", { name: "App-wide memory" }),
    ).toHaveValue("");
  });

  it("confirms disable and warns about the unsaved draft", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Unsaved");
    await user.click(screen.getByRole("switch", { name: "App-wide memory" }));

    expect(setUserMemoryEnabled).not.toHaveBeenCalled();
    expect(
      screen.getByText("Turn off and delete app-wide memory?"),
    ).toBeVisible();
    expect(
      screen.getByText(/delete the existing app-wide memory\.md file/i),
    ).toBeVisible();
    expect(screen.getByText(/and your unsaved draft/i)).toBeVisible();
    expect(screen.getByText(/cancel pending memory updates/i)).toBeVisible();
    expect(screen.getByText(/stop future memory updates/i)).toBeVisible();
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(updateUserMemory).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(false),
    );
    expect(
      screen.queryByRole("textbox", { name: "App-wide memory" }),
    ).not.toBeInTheDocument();
  });

  it("treats a null head as empty even when its CAS version is positive", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      current({
        content: "",
        revision: 7,
        hash: null,
        updated_at: null,
        updated_by: null,
      }),
    );

    render(<UserMemoryPage />);

    await screen.findByRole("textbox", { name: "App-wide memory" });
    expect(
      screen.queryByRole("button", { name: "Download memory.md" }),
    ).toBeNull();
    expect(screen.queryByText(/No saved memory yet/)).toBeNull();
    // The CAS token is concurrency plumbing; it must never reach the page.
    expect(screen.queryByText(/Version/)).not.toBeInTheDocument();
  });

  it("shows a failed automatic update once and remembers dismissal", async () => {
    const user = userEvent.setup();
    vi.mocked(getUserMemory).mockResolvedValue(current({ status: "failed" }));

    const { unmount } = render(<UserMemoryPage />);

    expect(
      await screen.findByRole("alert", {
        name: undefined,
      }),
    ).toHaveTextContent("The latest automatic update failed");

    await user.click(screen.getByRole("button", { name: "Dismiss warning" }));
    expect(screen.queryByRole("alert")).toBeNull();

    unmount();
    render(<UserMemoryPage />);
    await screen.findByRole("textbox", { name: "App-wide memory" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves the account default applied to new projects", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const toggle = await screen.findByRole("switch", {
      name: "Project memory for new projects",
    });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    await user.click(toggle);

    await waitFor(() =>
      expect(profileState.updateProjectMemoryDefault).toHaveBeenCalledWith(
        false,
      ),
    );
    // Turning app-wide memory off must not disable it: the two settings are
    // independent, and other owners still control their own projects.
    expect(setUserMemoryEnabled).not.toHaveBeenCalled();
  });

  it("keeps the project default usable when the memory file cannot load", async () => {
    profileState.projectMemoryDefault = false;
    vi.mocked(getUserMemory).mockRejectedValue(new Error("unavailable"));

    render(<UserMemoryPage />);

    expect(
      await screen.findByText("Memory settings are unavailable"),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Project memory for new projects" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("reports a scheduled automatic review beside the file heading", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      current({ status: "scheduled" }),
    );

    render(<UserMemoryPage />);

    // The toggle carries no on/off label of its own, so this stamp is the
    // only place the pending review is announced.
    expect(await screen.findByText(/Memory review scheduled/)).toBeVisible();
    expect(screen.queryByText(/^On\b/)).toBeNull();
  });
});
