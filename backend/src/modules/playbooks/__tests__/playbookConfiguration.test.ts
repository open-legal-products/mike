import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const { getUserApiKeys, getEffectiveApiKeys, routerModels, workspace } =
  vi.hoisted(() => ({
    getUserApiKeys: vi.fn(),
    getEffectiveApiKeys: vi.fn(),
    routerModels: {
      current: {} as Record<string, string[]>,
    },
    workspace: { current: null as Record<string, unknown> | null },
  }));

vi.mock("../../../lib/providerCredentials/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/providerCredentials/index")>()),
  getUserApiKeys,
  getEffectiveApiKeys,
}));
vi.mock("../../../lib/routerModels", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../lib/routerModels")>();
  return {
    ...actual,
    getEffectiveRouterModels: vi.fn(async () => ({
      ...Object.fromEntries(actual.ROUTER_SLUGS.map((slug) => [slug, []])),
      ...routerModels.current,
    })),
  };
});
vi.mock("../../../lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/workspace")>()),
  resolveWorkspaceFilter: vi.fn(async (_db: unknown, _user: string, raw: unknown) => ({
    ok: true,
    workspace: raw ?? null,
  })),
}));
vi.mock("../../../lib/orgPreferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/orgPreferences")>()),
  loadWorkspacePreferences: vi.fn(async () => workspace.current),
}));

import { playbookConfiguration } from "../playbooks.operations";

function dbWithProfile(profile: Record<string, unknown> | null): Db {
  const query: Record<string, unknown> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => ({ data: profile, error: null }));
  return { from: vi.fn(() => query) } as unknown as Db;
}

describe("playbookConfiguration", () => {
  beforeEach(() => {
    routerModels.current = {};
    workspace.current = null;
    getUserApiKeys.mockResolvedValue({
      claude: "sk-ant",
      gemini: "gm",
      openai: "sk-oa",
    });
  });

  it("defaults to the assistant's last selected chat model", async () => {
    const config = await playbookConfiguration(
      "u1",
      dbWithProfile({
        last_selected_chat_model: "gpt-6.1-sol",
        title_model: "gemini-3.8-flash",
        tabular_model: "claude-sonnet-5-5",
      }),
    );

    expect(config.defaultModel).toBe("gpt-6.1-sol");
  });

  it("maps a legacy chat model id to its current equivalent", async () => {
    const config = await playbookConfiguration(
      "u1",
      dbWithProfile({ last_selected_chat_model: "claude-opus-4-7" }),
    );

    expect(config.defaultModel).toBe("claude-opus-5-5");
  });

  it("falls back to a background-task model when the chat model is unavailable", async () => {
    getUserApiKeys.mockResolvedValue({ gemini: "gm" });

    const config = await playbookConfiguration(
      "u1",
      dbWithProfile({
        last_selected_chat_model: "gpt-6.1-sol",
        title_model: "gemini-3.8-flash",
      }),
    );

    expect(config.defaultModel).toBe("gemini-3.8-flash");
  });

  it("takes the background-task models from the organization in its workspace", async () => {
    getEffectiveApiKeys.mockResolvedValue({ gemini: "gm", claude: "sk-ant" });
    workspace.current = { title_model: "gemini-3.8-flash", tabular_model: null };

    const config = await playbookConfiguration(
      "u1",
      dbWithProfile({ title_model: "claude-sonnet-5-5" }),
      "org-1",
    );

    expect(config.defaultModel).toBe("gemini-3.8-flash");
  });

  it("skips a router model that is no longer selected for its router", async () => {
    getUserApiKeys.mockResolvedValue({ gemini: "gm", openrouter: "or" });
    const profile = {
      last_selected_chat_model: "openrouter/acme/model-x",
      title_model: "gemini-3.8-flash",
    };

    const deselected = await playbookConfiguration("u1", dbWithProfile(profile));
    expect(deselected.defaultModel).toBe("gemini-3.8-flash");
    expect(deselected.availableModelIds).not.toContain("openrouter/acme/model-x");

    routerModels.current = { openrouter: ["acme/model-x"] };
    const selected = await playbookConfiguration("u1", dbWithProfile(profile));
    expect(selected.defaultModel).toBe("openrouter/acme/model-x");
  });
});
