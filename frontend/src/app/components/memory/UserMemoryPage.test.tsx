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

// The page shows the memory for the active workspace: Personal here, unless
// a test moves to an organization.
const workspaceState = vi.hoisted(() => ({
  workspaceId: "personal" as string,
  activeOrganization: null as { id: string; name: string } | null,
  organizations: [] as { id: string; name: string }[] | null,
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => workspaceState,
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
    workspaceState.workspaceId = "personal";
    workspaceState.activeOrganization = null;
    workspaceState.organizations = [];
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

  it("says nothing about other workspaces to someone who has only Personal", async () => {
    render(<UserMemoryPage />);

    expect(
      await screen.findByText(
        "Let Mike curate useful details after your saved conversations and use them in future answers.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/separate memory for each workspace/)).toBeNull();
  });

  it("tells someone in an organization that Personal has its own memory", async () => {
    workspaceState.organizations = [{ id: "org-1", name: "Acme LLP" }];
    render(<UserMemoryPage />);

    expect(
      await screen.findByText(/in Personal and use them in future answers there\. You have a separate memory for each workspace\./),
    ).toBeInTheDocument();
  });

  it("loads the current file independently and autosaves editor changes", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "Personal memory",
    });
    const toggle = screen.getByRole("switch", { name: "Personal memory" });
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
      () => expect(updateUserMemory).toHaveBeenCalledWith("# Saved", 2, "personal"),
      { timeout: 2000 },
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("pauses curator polling while the tab is hidden and backs off while nothing changes", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(current({ status: "processing" }));
    render(<UserMemoryPage />);
    await screen.findByRole("textbox", { name: "Personal memory" });
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
      name: "Personal memory",
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
      screen.getByRole("switch", { name: "Personal memory" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(updateUserMemory).toHaveBeenCalledTimes(1);
  });

  it("clears the refusal notice when memory is turned back on", async () => {
    // The project modal already did this. On the settings page the "your
    // changes were not saved" line survived the re-enable and sat next to a
    // fresh, empty file, reading as if the new file were already failing.
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
      name: "Personal memory",
    });
    vi.mocked(getUserMemory).mockResolvedValue(
      current({ enabled: false, content: "", hash: null, revision: 5 }),
    );
    await user.clear(editor);
    await user.type(editor, "# Lost");
    const notice = await screen.findByText(
      "Memory was turned off while you were editing, so your changes were not saved.",
      {},
      { timeout: 2000 },
    );
    expect(notice).toBeVisible();

    vi.mocked(setUserMemoryEnabled).mockResolvedValue(
      current({ enabled: true, content: "", hash: null, revision: 5 }),
    );
    await user.click(screen.getByRole("switch", { name: "Personal memory" }));

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Memory was turned off while you were editing, so your changes were not saved.",
        ),
      ).toBeNull(),
    );
  });

  it("does not replay a refused draft when the settings page unmounts", async () => {
    // The unmount flush ran unconditionally: after a refusal it re-sent the
    // same stale draft with the old revision and failed where nobody could
    // see it. Only an ordinary pending edit may flush.
    vi.mocked(updateUserMemory).mockRejectedValueOnce(
      new MikeApiError({
        status: 409,
        code: "memory_disabled",
        message: "Enable memory before editing it.",
      }),
    );
    const user = userEvent.setup();
    const { unmount } = render(<UserMemoryPage />);
    const editor = await screen.findByRole("textbox", {
      name: "Personal memory",
    });
    vi.mocked(getUserMemory).mockResolvedValue(
      current({ enabled: false, content: "", hash: null, revision: 5 }),
    );
    await user.clear(editor);
    await user.type(editor, "# Lost");
    await screen.findByText(
      "Memory was turned off while you were editing, so your changes were not saved.",
      {},
      { timeout: 2000 },
    );
    expect(updateUserMemory).toHaveBeenCalledTimes(1);

    unmount();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updateUserMemory).toHaveBeenCalledTimes(1);
  });

  it("adopts server-normalized Markdown without repeatedly saving it", async () => {
    vi.mocked(updateUserMemory).mockResolvedValue(
      current({ content: "# Normalized", revision: 3, hash: "hash-3" }),
    );
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "Personal memory",
    });
    await screen.findByRole("switch", { name: "Personal memory" });

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
      name: "Personal memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Pending");

    await waitFor(
      () => expect(updateUserMemory).toHaveBeenCalledWith("# Pending", 2, "personal"),
      { timeout: 2000 },
    );
    expect(editor).not.toHaveAttribute("readonly");
    expect(
      screen.getByRole("switch", { name: "Personal memory" }),
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
          "personal",
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
      name: "Personal memory",
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
      () => expect(updateUserMemory).toHaveBeenLastCalledWith("# My draft", 3, "personal"),
      { timeout: 2000 },
    );
  });

  it("keeps a failed autosave draft and lets the user retry it", async () => {
    vi.mocked(updateUserMemory).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "Personal memory",
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
        expect(updateUserMemory).toHaveBeenLastCalledWith("# Still here", 2, "personal"),
      { timeout: 2000 },
    );
    expect(await screen.findByText("Saved")).toBeVisible();
  });

  it("flushes a pending autosave when the settings page unmounts", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "Personal memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Save on leave");
    expect(updateUserMemory).not.toHaveBeenCalled();

    unmount();

    await waitFor(() =>
      expect(updateUserMemory).toHaveBeenCalledWith("# Save on leave", 2, "personal"),
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
      name: "Personal memory",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.queryByRole("textbox", { name: "Personal memory" }),
    ).not.toBeInTheDocument();

    await user.click(toggle);

    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(true, "personal"),
    );
    expect(
      await screen.findByRole("textbox", { name: "Personal memory" }),
    ).toHaveValue("");
  });

  it("confirms disable and warns about the unsaved draft", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "Personal memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Unsaved");
    await user.click(screen.getByRole("switch", { name: "Personal memory" }));

    expect(setUserMemoryEnabled).not.toHaveBeenCalled();
    expect(
      screen.getByText("Turn off and delete your Personal memory?"),
    ).toBeVisible();
    expect(
      screen.getByText(/delete the existing memory\.md file and your unsaved draft/i),
    ).toBeVisible();
    expect(screen.getByText(/and your unsaved draft/i)).toBeVisible();
    expect(screen.getByText(/cancel pending memory updates/i)).toBeVisible();
    expect(screen.getByText(/stop future memory updates/i)).toBeVisible();
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(updateUserMemory).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(false, "personal"),
    );
    expect(
      screen.queryByRole("textbox", { name: "Personal memory" }),
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

    await screen.findByRole("textbox", { name: "Personal memory" });
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
    await screen.findByRole("textbox", { name: "Personal memory" });
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

// A person has one memory per workspace, each private to them. The page
// shows, and changes, the one for the active workspace.
describe("UserMemoryPage in an organization's workspace", () => {
  const ACME = { id: "org-1", name: "Acme LLP" };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    workspaceState.workspaceId = ACME.id;
    workspaceState.activeOrganization = ACME;
    workspaceState.organizations = [ACME];
    profileState.projectMemoryDefault = true;
    vi.mocked(getUserMemory).mockResolvedValue(
      current({ content: "# Learned at Acme" }),
    );
    vi.mocked(updateUserMemory).mockImplementation(async (content) =>
      current({ content, revision: 3, hash: "hash-3" }),
    );
    vi.mocked(setUserMemoryEnabled).mockImplementation(async (enabled) =>
      current({ enabled, content: "", revision: 3, hash: null }),
    );
  });

  it("loads that organization's memory and names it", async () => {
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "Memory in Acme LLP",
    });
    expect(editor).toHaveValue("# Learned at Acme");
    expect(getUserMemory).toHaveBeenCalledWith(expect.anything(), ACME.id);
    expect(
      screen.getByRole("switch", { name: "Memory in Acme LLP" }),
    ).toBeInTheDocument();
    // It says whose eyes it is for, and that it is this workspace's only.
    expect(
      screen.getByText(/Only you can see it\. You have a separate memory for each workspace\./),
    ).toBeInTheDocument();
  });

  it("saves edits into that organization's memory", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);
    const editor = await screen.findByRole("textbox", {
      name: "Memory in Acme LLP",
    });

    await user.clear(editor);
    await user.type(editor, "# Saved at Acme");
    await waitFor(
      () =>
        expect(updateUserMemory).toHaveBeenLastCalledWith(
          "# Saved at Acme",
          2,
          ACME.id,
        ),
      { timeout: 2000 },
    );
  });

  it("turns off that organization's memory only, and says so", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);
    await user.click(
      await screen.findByRole("switch", { name: "Memory in Acme LLP" }),
    );

    expect(
      screen.getByText("Turn off and delete your memory in Acme LLP?"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your memory in other workspaces is not affected\./),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(setUserMemoryEnabled).toHaveBeenCalledWith(false, ACME.id),
    );
  });

  it("starts again from the other file when the workspace changes", async () => {
    vi.mocked(getUserMemory).mockImplementation(async (_signal, workspace) =>
      current({
        content: workspace === ACME.id ? "# Learned at Acme" : "# Personal",
      }),
    );
    const { rerender } = render(<UserMemoryPage />);
    expect(
      await screen.findByRole("textbox", { name: "Memory in Acme LLP" }),
    ).toHaveValue("# Learned at Acme");

    workspaceState.workspaceId = "personal";
    workspaceState.activeOrganization = null;
    rerender(<UserMemoryPage />);

    const personal = await screen.findByRole("textbox", {
      name: "Personal memory",
    });
    expect(personal).toHaveValue("# Personal");
    // Nothing of the organization's is left on screen.
    expect(
      screen.queryByRole("textbox", { name: "Memory in Acme LLP" }),
    ).not.toBeInTheDocument();
    expect(getUserMemory).toHaveBeenLastCalledWith(
      expect.anything(),
      "personal",
    );
  });
});
