import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOrgPreferences,
  getWebSearchSettings,
  saveOrgApiKey,
  updateWebSearchSettings,
} from "@/app/lib/mikeApi";
import { OrganizationWebSearchSection } from "./WebSearchSection";

// An organization's web search settings govern work in its workspace: they
// are read and saved as the organization's, its model keys decide which
// families can search, and a search service's key is the organization's.

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrgPreferences: vi.fn(),
  getWebSearchSettings: vi.fn(),
  updateWebSearchSettings: vi.fn(),
  saveOrgApiKey: vi.fn(),
}));

const workspace = vi.hoisted(() => ({
  refreshOrgApiKeys: vi.fn(async () => {}),
  orgApiKeys: { keys: {} } as {
    keys: Record<string, unknown> & { sources?: Record<string, string | null> };
  },
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  useWorkspace: () => workspace,
}));

// The organization's keys: OpenAI, not Claude.
vi.mock("@/app/hooks/useModelApiKeys", () => ({
  useModelApiKeys: () =>
    Object.fromEntries(
      ["claude", "openai", "brave", "tavily", "deepseek"].map((provider) => [
        provider,
        { configured: provider === "openai", enabled: true, source: "org" },
      ]),
    ),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
  MfaVerificationPopup: () => null,
  needsMfaVerification: vi.fn().mockResolvedValue(false),
}));

// The caller's own settings are never read here.
vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => {
    throw new Error("the caller's profile is not used here");
  },
}));

const SETTINGS = {
  enabled: true,
  claude: "provider",
  openai: "provider",
  other: "brave",
} as const;

const save = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  workspace.orgApiKeys = { keys: {} };
  vi.mocked(getOrgPreferences).mockResolvedValue({
    web_search: SETTINGS,
  } as never);
  save.mockImplementation(async (update: { web_search: object }) => ({
    web_search: { ...SETTINGS, ...update.web_search },
  }));
});

describe("OrganizationWebSearchSection", () => {
  it("shows the organization's settings, for the families its keys can run", async () => {
    render(<OrganizationWebSearchSection orgId="org-1" save={save} />);

    expect(
      await screen.findByRole("button", { name: "OpenAI models" }),
    ).toHaveTextContent("OpenAI Search");
    expect(screen.queryByRole("button", { name: "Claude models" })).toBeNull();
    expect(getOrgPreferences).toHaveBeenCalledWith(
      "org-1",
      expect.any(AbortSignal),
    );
    expect(getWebSearchSettings).not.toHaveBeenCalled();
  });

  it("saves a change as the organization's", async () => {
    render(<OrganizationWebSearchSection orgId="org-1" save={save} />);
    const toggle = await screen.findByRole("switch", {
      name: "Enable web search",
    });

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ web_search: { enabled: false } }),
    );
    expect(updateWebSearchSettings).not.toHaveBeenCalled();
  });

  it("keeps a search service's key as the organization's", async () => {
    vi.mocked(saveOrgApiKey).mockResolvedValue({} as never);
    render(<OrganizationWebSearchSection orgId="org-1" save={save} />);

    const field = await screen.findByLabelText("Brave Search API Key");
    fireEvent.change(field, { target: { value: " brave-key " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(saveOrgApiKey).toHaveBeenCalledWith("org-1", "brave", "brave-key"),
    );
    expect(workspace.refreshOrgApiKeys).toHaveBeenCalled();
  });

  it("does not offer a deployment-wide key as the organization's to remove", async () => {
    workspace.orgApiKeys = {
      keys: { brave: true, sources: { brave: "env" } },
    };
    const { unmount } = render(
      <OrganizationWebSearchSection orgId="org-1" save={save} />,
    );
    await screen.findByLabelText("Brave Search API Key");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    unmount();

    workspace.orgApiKeys = {
      keys: { brave: true, sources: { brave: "org" } },
    };
    render(<OrganizationWebSearchSection orgId="org-1" save={save} />);
    await screen.findByLabelText("Brave Search API Key");
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });
});
