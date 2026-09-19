import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlaybook,
  getPlaybookConfiguration,
  importPlaybook,
  listPlaybooks,
  reviewDocumentWithPlaybook,
  type Playbook,
  type PlaybookRun,
} from "@/app/lib/mikeApi";
import PlaybooksPage from "./page";

vi.mock("@/app/lib/mikeApi", () => ({
  createPlaybook: vi.fn(),
  listPlaybooks: vi.fn(),
  getPlaybookConfiguration: vi.fn(),
  importPlaybook: vi.fn(),
  updatePlaybook: vi.fn(),
  publishPlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  reviewDocumentWithPlaybook: vi.fn(),
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
  useOllamaModels: () => [],
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: null }),
}));

function playbook(id: string, name: string): Playbook {
  return {
    id,
    userId: "u1",
    name,
    description: "",
    status: "published",
    draft: {
      name,
      description: "",
      representedParty: "Customer",
      globalGuidance: "",
      documentTypes: [],
      jurisdictions: [],
      topics: [
        {
          id: `${id}-liability`,
          name: "Liability",
          rules: [
            {
              id: `${id}-cap`,
              name: "Liability cap",
              concept: "",
              scope: "clause",
              required: true,
              guidance: "",
              standard: null,
              fallbacks: [],
              unacceptable: [],
              conditions: [],
              actions: [],
              sourceRefs: [],
            },
          ],
        },
      ],
    },
    publishedVersionId: `${id}-v1`,
    publishedVersionNumber: 1,
    publishedName: name,
    sourceFilename: null,
    importModel: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Playbook;
}

const RUN: PlaybookRun = {
  id: "run-1",
  playbookId: "pb-a",
  versionId: "pb-a-v1",
  versionNumber: 1,
  model: "claude-opus-5",
  documentName: "contract.docx",
  reviewMode: "strict",
  status: "completed",
  summary: "Playbook A found an uncapped liability clause.",
  findings: [],
  error: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:01:00.000Z",
};

describe("playbooks page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.mocked(listPlaybooks).mockResolvedValue([
      playbook("pb-a", "Playbook A"),
      playbook("pb-b", "Playbook B"),
    ]);
    vi.mocked(getPlaybookConfiguration).mockResolvedValue({
      availableModelIds: ["claude-opus-5"],
      defaultModel: "claude-opus-5",
    });
    vi.mocked(reviewDocumentWithPlaybook).mockResolvedValue(RUN);
    vi.mocked(createPlaybook).mockResolvedValue(playbook("pb-new", "Untitled playbook"));
    vi.mocked(importPlaybook).mockResolvedValue(playbook("pb-a", "Replaced"));
  });

  it("names the topic toggle and reports whether it is expanded", async () => {
    render(<PlaybooksPage />);

    const toggle = await screen.findByRole("button", {
      name: /collapse topic Liability/i,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(toggle);

    const collapsed = await screen.findByRole("button", {
      name: /expand topic Liability/i,
    });
    expect(collapsed).toHaveAttribute("aria-expanded", "false");
  });

  it("does not show one playbook's review under another playbook", async () => {
    render(<PlaybooksPage />);

    // Run a review against Playbook A. The detail panel commits after the
    // sidebar, so wait for the action rather than the list entry.
    await userEvent.click(
      await screen.findByRole("button", { name: /Review document/i }),
    );
    await userEvent.upload(
      screen.getByLabelText(/^Contract$/i),
      new File(["A contract."], "contract.txt", { type: "text/plain" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /Start review/i }));

    expect(await screen.findByText(RUN.summary as string)).toBeInTheDocument();

    // Switching playbooks must not carry Playbook A's findings across.
    await userEvent.click(screen.getByRole("button", { name: /Playbook B/i }));

    await waitFor(() => {
      expect(screen.queryByText(RUN.summary as string)).toBeNull();
    });
    expect(screen.queryByText(/Latest review/i)).toBeNull();
  });

  it("offers both ways to add a playbook", async () => {
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /New playbook/i }),
    );

    expect(
      await screen.findByRole("menuitem", { name: /Import Word playbook/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /Start from scratch/i }),
    ).toBeInTheDocument();
  });

  it("creates a blank playbook and selects it", async () => {
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /New playbook/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Start from scratch/i }),
    );

    await waitFor(() => expect(createPlaybook).toHaveBeenCalled());
    expect(
      await screen.findByRole("button", { name: /Untitled playbook/i }),
    ).toBeInTheDocument();
  });

  it("names both ways to begin when there are no playbooks", async () => {
    vi.mocked(listPlaybooks).mockResolvedValue([]);
    render(<PlaybooksPage />);

    expect(
      await screen.findByRole("button", { name: /Import Word playbook/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start from scratch/i }),
    ).toBeInTheDocument();
  });

  it("replaces the selected playbook from a Word file", async () => {
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Replace from Word/i }),
    );
    await userEvent.upload(
      screen.getByLabelText(/Word playbook/i),
      new File(["docx"], "updated.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Replace and compile/i }),
    );

    await waitFor(() =>
      expect(importPlaybook).toHaveBeenCalledWith(
        expect.any(File),
        "claude-opus-5",
        "",
        "pb-a",
      ),
    );

    // The replacement rewrites a playbook; it must not add a second row.
    const rows = await screen.findAllByRole("button", { name: /Replaced/i });
    expect(rows).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Playbook A/i })).toBeNull();
  });

  it("does not ask for a name when replacing", async () => {
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /Replace from Word/i }),
    );

    // The editor's own "Playbook name" field stays; only the modal's
    // optional-name input is hidden, because a replacement keeps the name.
    expect(screen.queryByLabelText(/Playbook name \(optional\)/i)).toBeNull();
    expect(screen.getByLabelText(/Word playbook/i)).toBeInTheDocument();
  });
});
