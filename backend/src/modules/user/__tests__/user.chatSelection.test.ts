import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
const settings = vi.hoisted(() => vi.fn());
vi.mock("../user.settings", () => ({ getUserModelSettings: settings }));
import { resolveUserChatSelection } from "../user.chatSelection";

const profile = {
  last_selected_chat_model: "gemini-3.7-flash",
  last_selected_reasoning_level: "low",
  api_keys: { openai: "dummy", claude: "dummy", gemini: "dummy" },
};
const db = {} as Db; // Model selection with built-in models performs no writes.
beforeEach(() => {
  vi.clearAllMocks();
  settings.mockResolvedValue(profile);
});

describe("cross-surface chat selection", () => {
  it.each([
    [
      { requestedModel: "gpt-5.6-luna", chatModel: "claude-fable-5" },
      "gpt-5.6-luna",
    ],
    [{ chatModel: "claude-fable-5" }, "claude-fable-5"],
    [{}, "gemini-3.7-flash"],
  ])(
    "selects request, then chat, then profile: %j",
    async (args, selectedModel) => {
      expect(
        await resolveUserChatSelection(db, { userId: "actor", ...args }),
      ).toMatchObject({ ok: true, selectedModel, modelSettings: profile });
      expect(settings).toHaveBeenCalledExactlyOnceWith("actor", db);
    },
  );

  it.each([
    [{ requestedReasoning: "high", chatReasoningLevel: "medium" }, "high"],
    [{ chatReasoningLevel: "medium" }, "medium"],
    [{}, "low"],
    [{ requestedReasoning: "max" }, "xhigh"],
  ])(
    "selects and normalizes reasoning: %j",
    async (args, selectedReasoningLevel) => {
      expect(
        await resolveUserChatSelection(db, { userId: "actor", ...args }),
      ).toMatchObject({ ok: true, selectedReasoningLevel });
    },
  );

  it("keeps explicit invalid requests as failures instead of falling back", async () => {
    expect(
      await resolveUserChatSelection(db, {
        userId: "actor",
        requestedModel: "not-a-model",
      }),
    ).toMatchObject({ ok: false, status: 400, code: "model_unavailable" });
  });
  it("preserves the missing-key failure", async () => {
    settings.mockResolvedValue({ ...profile, api_keys: {} });
    expect(
      await resolveUserChatSelection(db, {
        userId: "actor",
        requestedModel: "gpt-5.6-luna",
      }),
    ).toMatchObject({ ok: false, status: 422, code: "missing_api_key" });
  });
  it("does not invent a model for a user without a selection", async () => {
    settings.mockResolvedValue({ ...profile, last_selected_chat_model: null });
    expect(
      await resolveUserChatSelection(db, { userId: "actor" }),
    ).toMatchObject({ ok: false, status: 400, code: "model_required" });
  });
});
