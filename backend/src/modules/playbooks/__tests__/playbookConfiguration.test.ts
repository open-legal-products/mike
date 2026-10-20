import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";

const { getUserApiKeys } = vi.hoisted(() => ({ getUserApiKeys: vi.fn() }));

vi.mock("../../user/user.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../user/user.service")>()),
  getUserApiKeys,
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
});
