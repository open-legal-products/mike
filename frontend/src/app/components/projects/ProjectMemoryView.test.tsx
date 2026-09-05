import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MikeApiError,
  getProjectMemory,
  listProjectMemoryVersions,
  restoreProjectMemoryVersion,
  setProjectMemoryEnabled,
  updateProjectMemory,
  wipeProjectMemory,
} from "@/app/lib/mikeApi";
import { ProjectMemoryView } from "./ProjectMemoryView";

const { allowedCapabilities, currentProject, setProject } = vi.hoisted(() => {
  const currentProject = {
    current: {
      id: "project-1",
      name: "Matter",
      memory_enabled: true,
    },
  };
  return {
    allowedCapabilities: { current: new Set<string>() },
    currentProject,
    setProject: vi.fn(
      (
        update:
          | typeof currentProject.current
          | ((
              current: typeof currentProject.current,
            ) => typeof currentProject.current | null),
      ) => {
        const next =
          typeof update === "function"
            ? update(currentProject.current)
            : update;
        if (next) currentProject.current = next;
      },
    ),
  };
});

vi.mock("./ProjectWorkspace", () => ({
  ProjectSectionToolbar: ({ actions }: { actions?: React.ReactNode }) => (
    <div data-testid="project-toolbar">{actions}</div>
  ),
  useProjectWorkspace: () => ({
    projectId: "project-1",
    project: currentProject.current,
    projectLoading: false,
    setProject,
    canDo: (capability: string) => allowedCapabilities.current.has(capability),
  }),
}));

vi.mock("@/app/components/ui/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    readOnly,
    ariaLabel,
  }: {
    value: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  downloadProjectMemoryMarkdown: vi.fn(),
  getProjectMemory: vi.fn(),
  listProjectMemoryVersions: vi.fn(),
  restoreProjectMemoryVersion: vi.fn(),
  setProjectMemoryEnabled: vi.fn(),
  updateProjectMemory: vi.fn(),
  wipeProjectMemory: vi.fn(),
}));

const CURRENT = {
  enabled: true,
  content: "# Matter facts",
  version: 2,
  hash: "hash-2",
  updated_at: "2026-09-05T01:00:00Z",
  updated_by: "Alex",
  source: "curator" as const,
  status: "idle" as const,
};

const OLD_VERSION = {
  id: "version-1",
  version: 1,
  hash: "hash-1",
  size_bytes: 24,
  created_at: "2026-09-04T01:00:00Z",
  updated_by: "Alex",
  source: "manual" as const,
  model: null,
  source_surface: null,
  source_chat_id: null,
  source_turn_id: null,
  change_summary: null,
};

describe("ProjectMemoryView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentProject.current = {
      id: "project-1",
      name: "Matter",
      memory_enabled: true,
    };
    allowedCapabilities.current = new Set(["project.view"]);
    vi.mocked(getProjectMemory).mockResolvedValue(CURRENT);
    vi.mocked(listProjectMemoryVersions).mockResolvedValue([
      { ...OLD_VERSION, id: "version-2", version: 2 },
      OLD_VERSION,
    ]);
  });

  it("lets viewers read memory without edit or restore controls", async () => {
    render(<ProjectMemoryView />);

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    expect(
      screen.getByText(/Last updated .* · Version 2 · Automatic update/),
    ).toBeVisible();
    expect(editor).toHaveValue("# Matter facts");
    expect(editor).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Wipe/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    expect(screen.queryByText(/Updated by Alex/)).toBeNull();
  });

  it("saves an editor's draft against the loaded version", async () => {
    allowedCapabilities.current = new Set(["project.view", "content.edit"]);
    vi.mocked(updateProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "# Updated",
      version: 3,
    });
    const user = userEvent.setup();
    render(<ProjectMemoryView />);

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await user.clear(editor);
    await user.type(editor, "# Draft");
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(editor).toHaveValue("# Matter facts");
    expect(updateProjectMemory).not.toHaveBeenCalled();

    await user.clear(editor);
    await user.type(editor, "# Updated");
    await user.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() =>
      expect(updateProjectMemory).toHaveBeenCalledWith(
        "project-1",
        "# Updated",
        2,
      ),
    );
    expect(await screen.findByText("Project memory saved")).toBeVisible();
  });

  it("keeps current memory available when only history fails", async () => {
    vi.mocked(listProjectMemoryVersions).mockRejectedValue(
      new Error("history unavailable"),
    );

    render(<ProjectMemoryView />);

    expect(
      await screen.findByRole("textbox", { name: "Project memory" }),
    ).toHaveValue("# Matter facts");
    expect(
      await screen.findByText("Version history could not be refreshed."),
    ).toBeVisible();
    expect(screen.queryByText("Project memory could not be loaded")).toBeNull();
  });

  it("preserves an editor's stale draft across a version conflict", async () => {
    allowedCapabilities.current = new Set(["project.view", "content.edit"]);
    const latest = {
      ...CURRENT,
      content: "# Automatic update",
      version: 3,
      hash: "hash-3",
    };
    vi.mocked(getProjectMemory)
      .mockResolvedValueOnce(CURRENT)
      .mockResolvedValueOnce(latest);
    vi.mocked(updateProjectMemory)
      .mockRejectedValueOnce(
        new MikeApiError({
          status: 409,
          code: "memory_version_conflict",
          message: "Memory changed",
        }),
      )
      .mockResolvedValueOnce({
        ...CURRENT,
        content: "# My draft",
        version: 4,
        hash: "hash-4",
      });
    const user = userEvent.setup();
    render(<ProjectMemoryView />);

    const editor = await screen.findByRole("textbox", {
      name: "Project memory",
    });
    await user.clear(editor);
    await user.type(editor, "# My draft");
    await user.click(screen.getByRole("button", { name: /Save/ }));

    expect(
      await screen.findByText("Project memory changed while you were editing"),
    ).toBeVisible();
    expect(editor).toHaveValue("# My draft");

    await user.click(screen.getByRole("button", { name: "Keep my draft" }));
    await user.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() =>
      expect(updateProjectMemory).toHaveBeenLastCalledWith(
        "project-1",
        "# My draft",
        3,
      ),
    );
  });

  it("restores an older version against the current version", async () => {
    allowedCapabilities.current = new Set(["project.view", "content.edit"]);
    vi.mocked(restoreProjectMemoryVersion).mockResolvedValue({
      ...CURRENT,
      content: "# Earlier",
      version: 3,
      hash: "hash-3",
    });
    const user = userEvent.setup();
    render(<ProjectMemoryView />);

    await screen.findByRole("textbox", { name: "Project memory" });
    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByText("Restore version 1?")).toBeVisible();

    const restoreButtons = screen.getAllByRole("button", {
      name: "Restore",
    });
    await user.click(restoreButtons.at(-1)!);

    await waitFor(() =>
      expect(restoreProjectMemoryVersion).toHaveBeenCalledWith(
        "project-1",
        "version-1",
        2,
      ),
    );
  });

  it("only enables disabled memory for a project owner", async () => {
    allowedCapabilities.current = new Set([
      "project.view",
      "content.edit",
      "access.manage",
    ]);
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      enabled: false,
      content: "",
      version: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
    });
    vi.mocked(setProjectMemoryEnabled).mockResolvedValue({
      ...CURRENT,
      content: "",
      version: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
    });
    const user = userEvent.setup();
    render(<ProjectMemoryView />);

    await user.click(await screen.findByRole("button", { name: "Enable" }));

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("project-1", true),
    );
    expect(await screen.findByText("Project memory enabled")).toBeVisible();
  });

  it("requires confirmation before an owner wipes memory history", async () => {
    allowedCapabilities.current = new Set([
      "project.view",
      "content.edit",
      "access.manage",
    ]);
    vi.mocked(wipeProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "",
      // Wipes clear the head while preserving a monotonic CAS token.
      version: 3,
      hash: null,
      updated_at: null,
      updated_by: null,
    });
    const user = userEvent.setup();
    render(<ProjectMemoryView />);

    await user.click(await screen.findByRole("button", { name: /Wipe/ }));
    expect(wipeProjectMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Delete project memory?")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Delete/ }));
    await waitFor(() =>
      expect(wipeProjectMemory).toHaveBeenCalledWith("project-1"),
    );
    expect(
      await screen.findByText("Project memory and version history deleted"),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Wipe project memory" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Download project memory.md" }),
    ).toBeDisabled();
    expect(screen.queryByText("Version 3")).toBeNull();
  });

  it("lets an owner wipe a pending first memory update", async () => {
    allowedCapabilities.current = new Set([
      "project.view",
      "content.edit",
      "access.manage",
    ]);
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "",
      version: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
      status: "scheduled",
    });

    render(<ProjectMemoryView />);

    expect(
      await screen.findByRole("button", {
        name: "Wipe project memory",
      }),
    ).toBeVisible();
  });

  it("polls until a scheduled project-memory update is visible", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getProjectMemory)
        .mockResolvedValueOnce({ ...CURRENT, status: "scheduled" })
        .mockResolvedValueOnce({
          ...CURRENT,
          content: "# Curated matter facts",
          version: 3,
          hash: "hash-3",
          status: "idle",
        });

      render(<ProjectMemoryView />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText(/Memory review scheduled/)).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(
        screen.getByRole("textbox", { name: "Project memory" }),
      ).toHaveValue("# Curated matter facts");
      expect(listProjectMemoryVersions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
