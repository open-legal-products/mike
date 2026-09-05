import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  downloadUserMemoryMarkdown,
  getUserMemory,
  listUserMemoryVersions,
  restoreUserMemoryVersion,
  updateUserMemory,
  type MemoryCurrent,
  type MemoryVersion,
} from "@/app/lib/mikeApi";
import { UserMemoryPage } from "./UserMemoryPage";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  downloadUserMemoryMarkdown: vi.fn(),
  getUserMemory: vi.fn(),
  listUserMemoryVersions: vi.fn(),
  restoreUserMemoryVersion: vi.fn(),
  updateUserMemory: vi.fn(),
}));

vi.mock("@/app/components/ui/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    ariaLabel,
    readOnly,
  }: {
    value: string;
    onChange?: (value: string) => void;
    ariaLabel?: string;
    readOnly?: boolean;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

function current(overrides: Partial<MemoryCurrent> = {}): MemoryCurrent {
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

function version(overrides: Partial<MemoryVersion> = {}): MemoryVersion {
  return {
    id: "version-2",
    version: 2,
    hash: "hash-2",
    size_bytes: 128,
    created_at: "2026-09-05T10:00:00.000Z",
    updated_by: "user-1",
    source: "manual",
    model: null,
    source_surface: null,
    source_chat_id: null,
    source_turn_id: null,
    change_summary: null,
    ...overrides,
  };
}

describe("UserMemoryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserMemory).mockResolvedValue(current());
    vi.mocked(listUserMemoryVersions).mockResolvedValue([
      version(),
      version({
        id: "version-1",
        version: 1,
        source: "curator",
        source_surface: "chat",
        change_summary: "Remembered a concise drafting preference",
      }),
    ]);
    vi.mocked(updateUserMemory).mockImplementation(async (content) =>
      current({ content, version: 3, hash: "hash-3" }),
    );
    vi.mocked(restoreUserMemoryVersion).mockResolvedValue(
      current({ content: "# Earlier", version: 3, hash: "hash-3" }),
    );
    vi.mocked(downloadUserMemoryMarkdown).mockResolvedValue({
      blob: new Blob(["# Preferences"]),
      filename: "memory.md",
    });
  });

  it("loads the current file independently, exposes a named editor, and can cancel or save a draft", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    expect(editor).toHaveValue("# Preferences");
    expect(
      screen.getByText(
        /may curate this Markdown file after saved conversations/i,
      ),
    ).toBeVisible();
    expect(screen.getByText("Version 2 · Current")).toBeVisible();
    expect(
      screen.getByText(/Last updated .* · Version 2 · Manual edit/),
    ).toBeVisible();
    expect(
      screen.getByText("Remembered a concise drafting preference"),
    ).toBeVisible();

    await user.clear(editor);
    await user.type(editor, "# Draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(editor).toHaveValue("# Preferences");
    expect(updateUserMemory).not.toHaveBeenCalled();

    await user.clear(editor);
    await user.type(editor, "# Saved");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateUserMemory).toHaveBeenCalledWith("# Saved", 2),
    );
    expect(await screen.findByText("Memory saved")).toBeVisible();
  });

  it("keeps the editor available when only version history fails", async () => {
    vi.mocked(listUserMemoryVersions).mockRejectedValue(
      new Error("history unavailable"),
    );

    render(<UserMemoryPage />);

    expect(
      await screen.findByRole("textbox", { name: "App-wide memory" }),
    ).toHaveValue("# Preferences");
    expect(
      await screen.findByText("Version history could not be refreshed."),
    ).toBeVisible();
    expect(
      screen.queryByText("Memory could not be loaded"),
    ).not.toBeInTheDocument();
  });

  it("preserves a stale draft and requires an explicit conflict choice", async () => {
    const latest = current({
      content: "# Automatic update",
      version: 3,
      hash: "hash-3",
    });
    vi.mocked(getUserMemory)
      .mockResolvedValueOnce(current())
      .mockResolvedValueOnce(latest);
    vi.mocked(updateUserMemory)
      .mockRejectedValueOnce(
        new MikeApiError({
          status: 409,
          code: "memory_version_conflict",
          message: "Memory changed",
        }),
      )
      .mockResolvedValueOnce(
        current({ content: "# My draft", version: 4, hash: "hash-4" }),
      );
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    const editor = await screen.findByRole("textbox", {
      name: "App-wide memory",
    });
    await user.clear(editor);
    await user.type(editor, "# My draft");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("Memory changed while you were editing"),
    ).toBeVisible();
    expect(editor).toHaveValue("# My draft");

    await user.click(screen.getByRole("button", { name: "Keep my draft" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateUserMemory).toHaveBeenLastCalledWith("# My draft", 3),
    );
  });

  it("confirms a restore and sends the current version for concurrency", async () => {
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    await screen.findByRole("textbox", { name: "App-wide memory" });
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByText("Restore version 1?")).toBeVisible();

    const restoreButtons = screen.getAllByRole("button", {
      name: "Restore",
    });
    await user.click(restoreButtons.at(-1)!);

    await waitFor(() =>
      expect(restoreUserMemoryVersion).toHaveBeenCalledWith("version-1", 2),
    );
    expect(await screen.findByText("Version 1 restored")).toBeVisible();
  });

  it("shows a settings path instead of an editor when memory is disabled", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      current({
        enabled: false,
        content: "",
        version: 0,
        hash: null,
        updated_at: null,
        updated_by: null,
      }),
    );
    const user = userEvent.setup();
    render(<UserMemoryPage />);

    expect(await screen.findByText("App-wide memory is off")).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "App-wide memory" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    expect(push).toHaveBeenCalledWith("/settings/features#memory");
  });

  it("treats a null head as empty even when its CAS version is positive", async () => {
    vi.mocked(getUserMemory).mockResolvedValue(
      current({
        content: "",
        version: 7,
        hash: null,
        updated_at: null,
        updated_by: null,
      }),
    );

    render(<UserMemoryPage />);

    await screen.findByRole("textbox", { name: "App-wide memory" });
    expect(
      screen.getByRole("button", { name: "Download memory.md" }),
    ).toBeDisabled();
    expect(screen.getByText("No saved memory yet")).toBeVisible();
    expect(screen.queryByText("Version 7")).not.toBeInTheDocument();
  });
});
