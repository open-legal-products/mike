import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWebSearchSettings,
  updateWebSearchSettings,
} from "@/app/lib/mikeApi";
import { notifyError } from "@/app/lib/userFacingError";
import { WebSearchSection } from "./WebSearchSection";

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getWebSearchSettings: vi.fn(),
  updateWebSearchSettings: vi.fn(),
}));

vi.mock("@/app/lib/userFacingError", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/userFacingError")>()),
  notifyError: vi.fn(),
}));

const keys = vi.hoisted(() => ({ configured: ["claude"] as string[] }));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({
    profile: {
      apiKeys: Object.fromEntries(
        ["claude", "openai", "brave", "tavily", "deepseek"].map((provider) => [
          provider,
          {
            configured: keys.configured.includes(provider),
            enabled: true,
            source: null,
          },
        ]),
      ),
    },
    updateApiKey: vi.fn(),
  }),
}));

const OFF = {
  enabled: false,
  claude: "provider",
  openai: "provider",
  other: "off",
} as const;

const toggle = () => screen.getByRole("switch", { name: "Enable web search" });

const trigger = (name: string) => screen.getByRole("button", { name });

describe("WebSearchSection", () => {
  beforeEach(() => {
    keys.configured = ["claude"];
    vi.mocked(updateWebSearchSettings).mockReset();
    vi.mocked(notifyError).mockReset();
    vi.mocked(getWebSearchSettings).mockResolvedValue(OFF);
  });

  it("offers a choice for each kind of model the user has set up", async () => {
    vi.mocked(updateWebSearchSettings).mockResolvedValue({ ...OFF, enabled: true });
    render(<WebSearchSection />);
    await waitFor(() => expect(toggle()).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(toggle());

    expect(updateWebSearchSettings).toHaveBeenCalledWith({ enabled: true });
    expect(trigger("Claude models")).toHaveTextContent("Anthropic Search");
    expect(trigger("Other models")).toHaveTextContent("Off");
    expect(screen.queryByRole("button", { name: "OpenAI models" })).toBeNull();
    expect(screen.queryByLabelText("Brave Search API Key")).toBeNull();
  });

  it("asks for a key for each search service chosen", async () => {
    vi.mocked(getWebSearchSettings).mockResolvedValue({
      ...OFF,
      enabled: true,
      claude: "brave",
      other: "tavily",
    });
    render(<WebSearchSection />);

    expect(await screen.findByLabelText("Brave Search API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Tavily API Key")).toBeInTheDocument();
    expect(screen.queryByLabelText("DeepSeek API Key")).toBeNull();
    expect(trigger("Other models")).toHaveTextContent("Tavily");
  });

  it("puts the switch back and raises a notice when the save fails", async () => {
    const failure = new Error("boom");
    vi.mocked(updateWebSearchSettings).mockRejectedValue(failure);
    render(<WebSearchSection />);
    await waitFor(() => expect(toggle()).toBeInTheDocument());

    fireEvent.click(toggle());

    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(failure, expect.anything()),
    );
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });
});
