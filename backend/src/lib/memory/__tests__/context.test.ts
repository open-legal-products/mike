import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMemoryCurrent } = vi.hoisted(() => ({
  getMemoryCurrent: vi.fn(),
}));

vi.mock("../files", () => ({
  getMemoryCurrent: (...args: unknown[]) => getMemoryCurrent(...args),
}));

import { buildMemoryPromptContext, MEMORY_SYSTEM_POLICY } from "../context";

beforeEach(() => {
  getMemoryCurrent.mockReset();
});

describe("buildMemoryPromptContext", () => {
  it("loads app and project memory in parallel", async () => {
    let resolveApp!: (value: unknown) => void;
    let resolveProject!: (value: unknown) => void;
    getMemoryCurrent
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveApp = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveProject = resolve;
        }),
      );

    const pending = buildMemoryPromptContext({
      db: {} as never,
      userId: "user-1",
      projectId: "project-1",
    });

    expect(getMemoryCurrent).toHaveBeenCalledTimes(2);
    resolveApp({ current: { enabled: true, content: "App" } });
    resolveProject({ current: { enabled: true, content: "Project" } });
    await expect(pending).resolves.toContain("Project");
  });

  it("injects enabled files with explicit precedence and no write capability", async () => {
    getMemoryCurrent
      .mockResolvedValueOnce({
        current: { enabled: true, content: "# App\n- concise" },
      })
      .mockResolvedValueOnce({
        current: { enabled: true, content: "# Project\n- Matter Alpha" },
      });

    const prompt = await buildMemoryPromptContext({
      db: {} as never,
      userId: "user-1",
      projectId: "project-1",
      sharedAudience: true,
    });

    expect(MEMORY_SYSTEM_POLICY).toContain(
      "current conversation over project memory",
    );
    expect(MEMORY_SYSTEM_POLICY).toContain("project memory over app memory");
    expect(prompt).toContain('scope="app"');
    expect(prompt).toContain('scope="project"');
    expect(prompt).toContain("# App");
    expect(prompt).toContain("# Project");
    expect(prompt).toContain("CONVERSATION AUDIENCE: SHARED");
    expect(MEMORY_SYSTEM_POLICY).toContain("never grants permissions");
    expect(MEMORY_SYSTEM_POLICY).toContain(
      "never reveal, quote, summarize, or otherwise expose a detail found only in app memory",
    );
  });

  it("omits disabled content and contains strict read failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    getMemoryCurrent
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce({
        current: { enabled: false, content: "must not appear" },
      });

    await expect(
      buildMemoryPromptContext({
        db: {} as never,
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toBe("");
    expect(warn).toHaveBeenCalledWith(
      "[memory-context] scoped memory could not be loaded",
      { scope: "app" },
    );
    warn.mockRestore();
  });
});
