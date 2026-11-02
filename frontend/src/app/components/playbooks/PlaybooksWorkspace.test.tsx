import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDocumentFile,
  getPlaybookPeople,
  listPlaybookShares,
  createPlaybook,
  getPlaybookConfiguration,
  getPlaybook,
  getPlaybookImport,
  listRunningPlaybookImports,
  startPlaybookImport,
  listPlaybooks,
  listAllPlaybookRuns,
  deletePlaybookRun,
  listPlaybookRuns,
  uploadLibraryDocument,
  listPlaybookSources,
  reviewDocumentWithPlaybook,
  updatePlaybook,
  deletePlaybook,
  MikeApiError,
  type Playbook,
  type PlaybookImport,
  type PlaybookRun,
} from "@/app/lib/mikeApi";
import { showToast } from "@/app/components/ui/toast";
import {
  clearToasts,
  getSnapshot as getToastSnapshot,
} from "@/shared/lib/toastStore";
import { PlaybooksWorkspaceLayout as PlaybooksPage } from "./PlaybooksWorkspace";
import { SETTINGS_MODELS } from "@/shared/lib/modelCatalog";

const TEST_MODEL = SETTINGS_MODELS[0].id;

// A small router: push and replace update the path and query, so tabs kept
// in ?tab= and playbook pages behave as they do in the app.
const navigation = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    params: {} as { playbookId?: string },
    search: "",
  };
  const go = (href: string) => {
    const url = new URL(href, "http://mike.test");
    const match = url.pathname.match(/^\/playbooks\/([^/]+)$/);
    state.params = match ? { playbookId: match[1] } : {};
    state.search = url.search.slice(1);
    listeners.forEach((listener) => listener());
  };
  const push = vi.fn(go);
  const replace = vi.fn(go);
  return {
    state,
    listeners,
    get params() {
      return state.params;
    },
    set params(value: { playbookId?: string }) {
      state.params = value;
    },
    get search() {
      return state.search;
    },
    set search(value: string) {
      state.search = value;
    },
    push,
    replace,
    router: { push, replace },
  };
});
vi.mock("next/navigation", async () => {
  const { useMemo, useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    navigation.listeners.add(listener);
    return () => {
      navigation.listeners.delete(listener);
    };
  };
  return {
    useRouter: () => navigation.router,
    useParams: () => useSyncExternalStore(subscribe, () => navigation.params),
    usePathname: () =>
      useSyncExternalStore(subscribe, () =>
        navigation.params.playbookId
          ? `/playbooks/${navigation.params.playbookId}`
          : "/playbooks",
      ),
    useSearchParams: () => {
      const search = useSyncExternalStore(subscribe, () => navigation.search);
      return useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getDocumentFile: vi.fn(),
  getPlaybookPeople: vi.fn(),
  listPlaybookShares: vi.fn(),
  createPlaybook: vi.fn(),
  listPlaybooks: vi.fn(),
  getPlaybookConfiguration: vi.fn(),
  startPlaybookImport: vi.fn(),
  getPlaybookImport: vi.fn(),
  listRunningPlaybookImports: vi.fn(),
  getPlaybook: vi.fn(),
  updatePlaybook: vi.fn(),
  deletePlaybook: vi.fn(),
  reviewDocumentWithPlaybook: vi.fn(),
  listPlaybookSources: vi.fn(),
  listPlaybookRuns: vi.fn(),
  listAllPlaybookRuns: vi.fn(),
  deletePlaybookRun: vi.fn(),
  uploadLibraryDocument: vi.fn(),
}));

vi.mock("@/app/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/components/ui/toast")>()),
  showToast: vi.fn(),
}));

/** An import as the server reports it while it compiles. */
function importAttempt(overrides: Partial<PlaybookImport> = {}): PlaybookImport {
  return {
    id: "imp-1",
    status: "running",
    stage: "checking_model",
    error: null,
    filename: "Standards.pdf",
    name: null,
    playbookId: null,
    startedAt: "2026-10-20T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

/** Lets the page's import poll run once. */
async function pollImports() {
  await act(() => vi.advanceTimersByTimeAsync(3000));
}

// The real viewer lazy-loads a Word renderer that jsdom cannot run.
vi.mock("@/app/components/shared/views/DocxView", () => ({
  DocxView: ({
    filename,
    displayUrl,
  }: {
    filename?: string;
    displayUrl?: string | null;
  }) => (
    <div
      role="document"
      aria-label={`Viewing ${filename}`}
      data-url={displayUrl}
    />
  ),
}));

vi.mock("@/app/hooks/useOllamaModels", () => ({
  useOllamaModels: () => [],
}));

vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u1", email: "owner@example.com" } }),
}));

vi.mock("@/app/contexts/UserProfileContext", () => ({
  useUserProfile: () => ({ profile: null }),
}));

const workspace = vi.hoisted(() => ({
  workspaceId: "personal",
  activeOrganization: null as { name: string } | null,
}));
vi.mock("@/app/contexts/WorkspaceContext", () => ({
  PERSONAL_WORKSPACE: "personal",
  useWorkspace: () => workspace,
  useDocumentWorkspace: () => workspace.workspaceId,
}));
vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
  AddDocumentsModal: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onSelect: (docs: unknown[]) => void;
  }) =>
    open ? (
      <>
        <button
          onClick={() =>
            onSelect([
              {
                id: "saved-1",
                filename: "saved.txt",
                current_version_id: "doc-version",
              },
            ])
          }
        >
          Choose saved contract
        </button>
        <button
          onClick={() =>
            onSelect([
              {
                id: "saved-1",
                filename: "saved.txt",
                current_version_id: "doc-version",
              },
              {
                id: "saved-2",
                filename: "another-saved.txt",
                current_version_id: "doc-version-2",
              },
            ])
          }
        >
          Choose saved contracts
        </button>
        <button
          onClick={() =>
            onSelect([
              {
                id: "saved-playbook",
                filename: "Standards.pdf",
                current_version_id: "playbook-version",
              },
            ])
          }
        >
          Choose saved playbook
        </button>
      </>
    ) : null,
}));

function playbook(id: string, name: string): Playbook {
  return {
    id,
    userId: "u1",
    name,
    description: "",
    orgId: null,
    visibility: "private",
    role: "owner",
    isCreator: true,
    canEdit: true,
    canManageAccess: true,
    sharedWith: [],
    creatorName: null,
    creatorPhoto: null,
    content: {
      name,
      description: "",
      representedParty: "Customer",
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
    sourceFilename: null,
    importModel: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Playbook;
}

const RUN: PlaybookRun = {
  id: "run-1",
  playbookId: "pb-a",
  model: TEST_MODEL,
  documentName: "contract.docx",
  reviewMode: "strict",
  status: "completed",
  summary: "Playbook A found an uncapped liability clause.",
  findings: [],
  error: null,
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:01:00.000Z",
};

/** Drops files on the new run's document area, as dragging them in does. */
function dropReviewFiles(files: File | File[]) {
  fireEvent.drop(screen.getByRole("region", { name: "Add documents" }), {
    dataTransfer: {
      files: Array.isArray(files) ? files : [files],
      types: ["Files"],
    },
  });
}

/** Opens the new-run form from the header's Use menu. */
async function openNewRun() {
  await userEvent.click(screen.getByRole("button", { name: "Use" }));
  await userEvent.click(
    await screen.findByRole("menuitem", { name: "Run playbook" }),
  );
}

describe("playbooks page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listPlaybookSources).mockResolvedValue([]);
    vi.mocked(listPlaybookRuns).mockResolvedValue([]);
    vi.mocked(listAllPlaybookRuns).mockResolvedValue([]);
    // A reviewed upload is saved to Library Files first.
    vi.mocked(uploadLibraryDocument).mockImplementation(
      async (_scope, file) =>
        ({ id: `stored-${file.name}`, filename: file.name }) as never,
    );
    navigation.params = {};
    navigation.search = "";
    workspace.workspaceId = "personal";
    workspace.activeOrganization = null;
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
      availableModelIds: [TEST_MODEL],
      defaultModel: TEST_MODEL,
    });
    vi.mocked(reviewDocumentWithPlaybook).mockResolvedValue(RUN);
    const blank = playbook("pb-new", "Untitled playbook");
    blank.content.rules = blank.content.topics[0].rules;
    blank.content.topics = [];
    vi.mocked(createPlaybook).mockResolvedValue(blank);
    vi.mocked(listRunningPlaybookImports).mockResolvedValue([]);
    vi.mocked(startPlaybookImport).mockResolvedValue(importAttempt());
    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({ status: "completed", playbookId: "pb-a" }),
    );
    vi.mocked(getPlaybook).mockResolvedValue(playbook("pb-a", "Replaced"));
    vi.mocked(updatePlaybook).mockImplementation(async (id, content) => ({
      ...playbook(id, content.name),
      content,
    }));
    vi.mocked(deletePlaybook).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives each playbook its own page and opens it from its link", async () => {
    render(<PlaybooksPage />);
    const link = await screen.findByRole("link", { name: "Playbook A" });
    expect(link).toHaveAttribute("href", "/playbooks/pb-a");

    await userEvent.click(link);

    expect(navigation.push).toHaveBeenCalledWith("/playbooks/pb-a");
    expect(screen.getByLabelText("Rule")).toHaveValue("Liability cap");
  });

  it("opens the playbook named in the URL", async () => {
    navigation.params = { playbookId: "pb-a" };
    render(<PlaybooksPage />);

    expect(await screen.findByLabelText("Rule")).toHaveValue("Liability cap");
    // The URL gains its default tab; it does not fall back to the list.
    expect(navigation.replace).toHaveBeenCalledWith(
      "/playbooks/pb-a?tab=rules",
      expect.anything(),
    );
    expect(navigation.replace).not.toHaveBeenCalledWith("/playbooks");
  });

  it("keeps a playbook's tab in the URL", async () => {
    navigation.params = { playbookId: "pb-a" };
    navigation.search = "tab=references";
    render(<PlaybooksPage />);

    // A shared link opens the tab it names.
    expect(
      await screen.findByRole("button", { name: "References", pressed: true }),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Rules" }));

    expect(navigation.push).toHaveBeenLastCalledWith(
      "/playbooks/pb-a?tab=rules",
      expect.anything(),
    );
    expect(
      screen.getByRole("region", { name: "Topics and rules" }),
    ).toBeVisible();
  });

  it("opens the run a link names, as History links do", async () => {
    vi.mocked(listPlaybookRuns).mockResolvedValue([
      { ...RUN, id: "run-new", documentName: "New.docx" },
      { ...RUN, id: "run-old", documentName: "Old.docx" },
    ]);
    navigation.params = { playbookId: "pb-a" };
    navigation.search = "tab=runs&run=run-old";
    render(<PlaybooksPage />);

    const list = await screen.findByRole("region", { name: "Your runs" });
    expect(
      await within(list).findByRole("button", { name: "Old.docx" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(within(list).getByRole("button", { name: "New.docx" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("keeps the list's tab in the URL and returns to it from a playbook", async () => {
    navigation.search = "tab=mine";
    render(<PlaybooksPage />);
    expect(
      await screen.findByRole("button", {
        name: "My playbooks",
        pressed: true,
      }),
    ).toBeVisible();

    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    // The real router changes the URL a moment after Back; hold it there.
    navigation.push.mockImplementationOnce(() => {});
    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(navigation.push).toHaveBeenLastCalledWith("/playbooks?tab=mine");
    // While the URL still names the playbook, the table shows, not a
    // loading playbook page.
    expect(
      screen.queryByRole("status", { name: "Loading playbook" }),
    ).toBeNull();
    expect(screen.getByRole("table", { name: "Playbooks" })).toBeVisible();
    await act(async () => navigation.replace("/playbooks?tab=mine"));
    await userEvent.click(screen.getByRole("button", { name: "Runs" }));
    expect(navigation.push).toHaveBeenLastCalledWith(
      "/playbooks?tab=runs",
      expect.anything(),
    );
  });

  it("keeps a linked playbook's page while the playbooks load", async () => {
    navigation.params = { playbookId: "pb-a" };
    let finish!: (items: Playbook[]) => void;
    vi.mocked(listPlaybooks).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<PlaybooksPage />);

    expect(
      screen.getByRole("status", { name: "Loading playbook" }),
    ).toBeInTheDocument();
    // A refresh must not flash the playbooks table.
    expect(screen.queryByRole("table", { name: "Playbooks" })).toBeNull();

    finish([playbook("pb-a", "Playbook A")]);

    expect(await screen.findByLabelText("Rule")).toHaveValue("Liability cap");
    expect(
      screen.queryByRole("status", { name: "Loading playbook" }),
    ).toBeNull();
  });

  it("shows the list when the linked playbook is not in this workspace", async () => {
    navigation.params = { playbookId: "gone" };
    render(<PlaybooksPage />);

    await screen.findByRole("link", { name: "Playbook A" });
    expect(navigation.replace).toHaveBeenCalledWith("/playbooks");
  });

  it("opens from the table and preserves content edits while switching between details and rules", async () => {
    render(<PlaybooksPage />);
    const table = await screen.findByRole("table", { name: "Playbooks" });
    await screen.findByRole("link", { name: "Playbook A" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual([
      "Name",
      "Creator",
      "Access",
      "Type",
      "Represented",
      "Jurisdiction",
      "Rules",
      "Updated",
      "Actions",
    ]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.queryByLabelText("Playbook name")).toBeNull();

    await userEvent.click(screen.getByRole("link", { name: "Playbook A" }));
    expect(screen.getByLabelText("Rule")).toHaveValue("Liability cap");
    expect(
      screen.queryByRole("button", { name: "Playbook details" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Playbook name")).toBeNull();
    const toolbar = screen.getByRole("navigation", {
      name: "Playbook toolbar",
    });
    expect(
      within(
        within(toolbar).getByRole("group", { name: "Playbook view" }),
      )
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Rules", "References", "Runs"]);
    const useButton = screen.getByRole("button", { name: "Use" });
    expect(useButton).toBeVisible();
    expect(toolbar).not.toContainElement(useButton);

    await userEvent.click(
      screen.getByRole("button", { name: "Liability cap" }),
    );
    expect(
      screen.getByRole("button", { name: "Liability cap" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.type(
      screen.getByLabelText("Concept to detect"),
      "Limit liability",
    );

    // The rest of the details are edited in a dialog, as in other features.
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Edit details" }),
    );
    const details = await screen.findByRole("dialog", { name: "Details" });
    for (const label of [
      "Playbook name",
      "Represented party",
      "Document types",
      "Jurisdictions",
      "Description",
    ]) {
      expect(within(details).getByLabelText(label)).toBeEnabled();
    }
    const update = within(details).getByRole("button", { name: "Update" });
    expect(update).toBeDisabled();
    await userEvent.type(
      within(details).getByLabelText("Description"),
      "Negotiation guide",
    );
    await userEvent.clear(within(details).getByLabelText("Represented party"));
    await userEvent.type(
      within(details).getByLabelText("Represented party"),
      "Buyer",
    );
    await userEvent.clear(within(details).getByLabelText("Playbook name"));
    await userEvent.type(
      within(details).getByLabelText("Playbook name"),
      "Updated playbook",
    );
    await userEvent.click(update);
    // The dialog's save carries the rule edit made before it.
    await waitFor(() =>
      expect(updatePlaybook).toHaveBeenLastCalledWith(
        "pb-a",
        expect.objectContaining({
          name: "Updated playbook",
          description: "Negotiation guide",
          representedParty: "Buyer",
          topics: [
            expect.objectContaining({
              rules: [expect.objectContaining({ concept: "Limit liability" })],
            }),
          ],
        }),
        { visibility: "private" },
      ),
    );
    await waitFor(() => expect(update).toBeDisabled());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Details" })).toBeNull();
    expect(screen.getByLabelText("Rule")).toHaveValue("Liability cap");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("link", {
        name: "Updated playbook",
      }),
    ).toBeInTheDocument();
  });

  it("adds, selects, and autosaves an ungrouped rule from the toolbar", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    const toolbar = screen.getByRole("navigation", {
      name: "Playbook toolbar",
    });
    await userEvent.click(
      within(toolbar).getByRole("button", { name: "New rule" }),
    );
    expect(screen.getByLabelText("Rule")).toHaveValue("New rule 2");
    expect(screen.getByRole("button", { name: "New rule 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(updatePlaybook).toHaveBeenCalledWith(
        "pb-a",
        expect.objectContaining({
          rules: [
            expect.objectContaining({ name: "New rule 2", scope: "clause" }),
          ],
          topics: playbook("pb-a", "Playbook A").content.topics,
        }),
        { visibility: "private" },
      ),
    );
  });

  it("reports a save refused because another tab is replacing the playbook", async () => {
    // This page never saw the import (another tab or device started it), so
    // only the server's refusal stops the save.
    const detail =
      "This playbook is being replaced. Wait for the import to finish.";
    vi.mocked(updatePlaybook).mockRejectedValue(
      new MikeApiError({ message: detail, status: 409 }),
    );
    clearToasts();
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      within(
        screen.getByRole("navigation", { name: "Playbook toolbar" }),
      ).getByRole("button", { name: "New rule" }),
    );

    expect(await screen.findByText("Couldn’t save")).toBeInTheDocument();
    // The error notice carries the server's sentence, not a generic one.
    expect(getToastSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tone: "error", message: detail }),
      ]),
    );
    clearToasts();
  });

  it("opens a newly added rule even when its topic was collapsed", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse topic Liability" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Topic actions for Liability" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Add rule" }));
    expect(screen.getByLabelText("Rule")).toHaveValue("New rule 2");
    expect(screen.getByRole("button", { name: "New rule 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Collapse topic Liability" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Concept to detect")).not.toHaveValue("");
  });

  it("shows a retryable load failure instead of an empty playbook collection", async () => {
    vi.mocked(listPlaybooks).mockRejectedValueOnce(
      new Error("private database stack"),
    );
    render(<PlaybooksPage />);
    await screen.findByText("Couldn’t load playbooks");
    expect(screen.queryByText("private database stack")).toBeNull();
    expect(screen.queryByText("No playbooks yet")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("link", { name: "Playbook A" }),
    ).toBeInTheDocument();
  });

  it("shares row actions with right-click and selection menus without opening the row", async () => {
    const user = userEvent.setup();
    render(<PlaybooksPage />);
    const link = await screen.findByRole("link", { name: "Playbook B" });
    const trigger = screen.getByRole("button", {
      name: "Actions for Playbook B",
    });
    const labels = ["Open", "Details", "Run", "People", "Delete"];
    const menuLabels = () =>
      within(screen.getByRole("menu"))
        .getAllByRole("menuitem")
        .map((item) => item.textContent);

    await user.click(trigger);
    expect(menuLabels()).toEqual(labels);
    expect(navigation.push).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.contextMenu(link.closest('[role="row"]')!, {
      clientX: 100,
      clientY: 200,
    });
    expect(menuLabels()).toEqual(labels);
    expect(navigation.push).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");

    await user.click(
      screen.getByRole("checkbox", { name: "Select Playbook B" }),
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(menuLabels()).toEqual(["Deselect rows", ...labels]);
    await user.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(navigation.push).toHaveBeenCalledWith("/playbooks/pb-b");
    expect(screen.getByLabelText("Rule")).toHaveValue("Liability cap");
  });

  it("opens Details for the row from its context menu", async () => {
    render(<PlaybooksPage />);
    const link = await screen.findByRole("link", { name: "Playbook B" });
    fireEvent.contextMenu(link.closest('[role="row"]')!, {
      clientX: 100,
      clientY: 200,
    });
    await userEvent.click(screen.getByRole("menuitem", { name: "Details" }));
    // The dialog opens over the list rather than opening the playbook.
    expect(navigation.push).not.toHaveBeenCalled();
    const details = await screen.findByRole("dialog", { name: "Details" });
    expect(within(details).getByLabelText("Playbook name")).toHaveValue(
      "Playbook B",
    );
    expect(
      within(details).getByRole("button", { name: "People" }),
    ).toBeEnabled();
    await userEvent.type(
      within(details).getByLabelText("Description"),
      "Supply terms",
    );
    await userEvent.click(
      within(details).getByRole("button", { name: "Update" }),
    );
    await waitFor(() =>
      expect(updatePlaybook).toHaveBeenCalledWith(
        "pb-b",
        expect.objectContaining({
          name: "Playbook B",
          description: "Supply terms",
        }),
        { visibility: "private" },
      ),
    );
    expect(screen.getByRole("link", { name: "Playbook B" })).toBeVisible();
  });

  it("runs the playbook named by the row menu", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for Playbook B" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Run" }));
    // The playbook opens on Runs, with the new-run form in the main pane.
    expect(
      await screen.findByRole("region", { name: "New run" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Runs" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    dropReviewFiles(new File(["Synthetic contract"], "contract.txt", { type: "text/plain" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() =>
      expect(reviewDocumentWithPlaybook).toHaveBeenCalledWith(
        "pb-b",
        expect.any(Object),
      ),
    );
  });

  it("starts a new run from the Runs toolbar and cancels it back to the results", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    const toolbar = screen.getByRole("navigation", {
      name: "Playbook toolbar",
    });
    // The button shows only on Runs, like New rule on Rules.
    expect(
      within(toolbar).queryByRole("button", { name: "New run" }),
    ).toBeNull();
    await userEvent.click(within(toolbar).getByRole("button", { name: "Runs" }));
    await userEvent.click(
      within(toolbar).getByRole("button", { name: "New run" }),
    );
    const form = screen.getByRole("region", { name: "New run" });
    // Optional instructions start empty: the review knows how to review.
    expect(within(form).getByLabelText(/Additional instructions/)).toHaveValue("");
    const scope = within(form).getByRole("group", { name: "Scope" });
    expect(
      within(scope).getByRole("button", { name: "Full review" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(scope).getByRole("button", { name: "Issues only" }));
    expect(scope).toHaveAccessibleDescription(
      "Reports only unacceptable, missing, and needs-review terms.",
    );
    const posture = within(form).getByRole("group", { name: "Posture" });
    expect(posture).toHaveAccessibleDescription(/flagged for review/);
    await userEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "New run" })).toBeNull();
    expect(
      await screen.findByRole("region", { name: "Run results" }),
    ).toBeVisible();
  });

  it("sends the chosen scope and posture with the review", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await openNewRun();
    dropReviewFiles(new File(["A contract."], "contract.txt", { type: "text/plain" }));
    const form = screen.getByRole("region", { name: "New run" });
    await userEvent.click(
      within(within(form).getByRole("group", { name: "Scope" })).getByRole("button", {
        name: "Issues only",
      }),
    );
    await userEvent.click(
      within(within(form).getByRole("group", { name: "Posture" })).getByRole("button", {
        name: "Permissive",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() =>
      expect(reviewDocumentWithPlaybook).toHaveBeenCalledWith(
        "pb-a",
        expect.objectContaining({
          reviewScope: "issues",
          reviewMode: "permissive",
          instructions: "",
        }),
      ),
    );
  });

  it("opens the assistant with the playbook after saving pending edits", async () => {
    let finishSave!: (book: Playbook) => void;
    vi.mocked(updatePlaybook).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.type(screen.getByLabelText("Concept to detect"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Use" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Use in assistant" }),
    );
    await waitFor(() => expect(updatePlaybook).toHaveBeenCalled());
    expect(navigation.push).not.toHaveBeenCalledWith(
      "/assistant?playbook=pb-a",
    );
    finishSave(playbook("pb-a", "Playbook A"));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/assistant?playbook=pb-a"),
    );
  });

  it("opens People for a table row without navigating into the playbook", async () => {
    vi.mocked(getPlaybookPeople).mockResolvedValue({
      scope: "direct",
      owner: {
        user_id: "u1",
        email: "owner@example.com",
        display_name: "Olive Owner",
      },
      members: [
        {
          email: "reader@example.com",
          display_name: "Rae Reader",
          role: "viewer",
        },
      ],
    });
    vi.mocked(listPlaybookShares).mockResolvedValue([]);
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Actions for Playbook B" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "People" }));
    expect(await screen.findByText("Rae Reader")).toBeInTheDocument();
    expect(getPlaybookPeople).toHaveBeenCalledWith("pb-b");
    expect(listPlaybookShares).toHaveBeenCalledWith("pb-b");
    expect(navigation.push).not.toHaveBeenCalled();
    expect(
      screen.getByRole("table", { name: "Playbooks", hidden: true }),
    ).toBeInTheDocument();
  });

  it("confirms and deletes only the context-menu row while preserving other selections", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Select Playbook A" }),
    );
    const row = screen
      .getByRole("link", { name: "Playbook B" })
      .closest('[role="row"]')!;
    fireEvent.contextMenu(row, { clientX: 100, clientY: 200 });
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const confirmation = screen.getByRole("dialog", {
      name: "Delete playbook?",
    });
    expect(confirmation).toHaveTextContent(
      "“Playbook B” and its rules will be deleted.",
    );
    expect(deletePlaybook).not.toHaveBeenCalled();
    await userEvent.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(deletePlaybook).not.toHaveBeenCalled();

    await userEvent.click(
      screen.getByRole("button", { name: "Actions for Playbook B" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await userEvent.click(
      within(
        screen.getByRole("dialog", { name: "Delete playbook?" }),
      ).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "Playbook B" })).toBeNull(),
    );
    expect(deletePlaybook).toHaveBeenCalledExactlyOnceWith("pb-b");
    expect(
      screen.getByRole("checkbox", { name: "Select Playbook A" }),
    ).toBeChecked();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it.each(["viewer", "editor"] as const)(
    "disables Delete in all menus for a shared %s",
    async (role) => {
      const shared = {
        ...playbook("pb-shared", "Shared playbook"),
        role,
        userId: "another-user",
        isCreator: false,
        canEdit: role === "editor",
        canManageAccess: false,
      };
      vi.mocked(listPlaybooks).mockResolvedValue([shared]);
      render(<PlaybooksPage />);
      const link = await screen.findByRole("link", { name: "Shared playbook" });
      await userEvent.click(
        screen.getByRole("button", { name: "Actions for Shared playbook" }),
      );
      expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await userEvent.keyboard("{Escape}");
      fireEvent.contextMenu(link.closest('[role="row"]')!, {
        clientX: 100,
        clientY: 200,
      });
      expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(screen.getByRole("menuitem", { name: "Run" })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await userEvent.keyboard("{Escape}");
      await userEvent.click(
        screen.getByRole("checkbox", { name: "Select Shared playbook" }),
      );
      await userEvent.click(screen.getByRole("button", { name: "Actions" }));
      expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(deletePlaybook).not.toHaveBeenCalled();
    },
  );

  it("returns to the table after a confirmed deletion", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete playbook" }),
    );
    expect(deletePlaybook).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      screen.queryByRole("dialog", { name: "Delete playbook?" }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "Playbook A" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete playbook" }),
    );
    await userEvent.click(
      within(
        screen.getByRole("dialog", { name: "Delete playbook?" }),
      ).getByRole("button", { name: "Delete" }),
    );
    await screen.findByRole("link", { name: "Playbook B" });
    expect(deletePlaybook).toHaveBeenCalledWith("pb-a");
    expect(screen.queryByRole("link", { name: "Playbook A" })).toBeNull();
  });

  it("names the topic toggle and reports whether it is expanded", async () => {
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );

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

    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );

    // Run a review against the playbook opened from the table.
    await screen.findByRole("button", { name: "Use" });
    await openNewRun();
    dropReviewFiles(new File(["A contract."], "contract.txt", { type: "text/plain" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Start review/i }),
    );

    expect(await screen.findByText(RUN.summary as string)).toBeInTheDocument();
    // A finished run opens on the Runs tab.
    expect(screen.getByRole("button", { name: "Runs" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      within(screen.getByRole("region", { name: "Your runs" })).getByRole(
        "button",
        { name: /contract\.docx/ },
      ),
    ).toHaveAttribute("aria-pressed", "true");

    // Returning to the table and opening another playbook clears the findings.
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("link", { name: /Playbook B/i }));

    await waitFor(() => {
      expect(screen.queryByText(RUN.summary as string)).toBeNull();
    });
    expect(screen.queryByText(/Latest review/i)).toBeNull();
  });

  it("lists runs across playbooks and opens one on its playbook", async () => {
    const older = {
      ...RUN,
      id: "run-0",
      documentName: "Old NDA.pdf",
      playbookName: "Playbook B",
      playbookId: "pb-b",
    };
    vi.mocked(listAllPlaybookRuns).mockResolvedValue([
      { ...RUN, playbookName: "Playbook A" },
      older,
    ]);
    vi.mocked(listPlaybookRuns).mockResolvedValue([older]);
    render(<PlaybooksPage />);
    await screen.findByRole("link", { name: "Playbook A" });

    await userEvent.click(screen.getByRole("button", { name: "Runs" }));

    const table = await screen.findByRole("table", { name: "Playbook runs" });
    expect(listAllPlaybookRuns).toHaveBeenCalledWith("personal");
    expect(within(table).getByText("Playbook B")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Search runs…" }));
    await userEvent.type(screen.getByPlaceholderText("Search runs…"), "NDA");
    expect(
      within(table).queryByRole("button", { name: "contract.docx" }),
    ).toBeNull();

    await userEvent.click(
      within(table).getByRole("button", { name: "Old NDA.pdf" }),
    );

    expect(navigation.push).toHaveBeenCalledWith("/playbooks/pb-b?tab=runs");
    expect(
      screen.getByRole("button", { name: "Runs", pressed: true }),
    ).toBeVisible();
    expect(
      await within(
        screen.getByRole("region", { name: "Your runs" }),
      ).findByRole("button", { name: "Old NDA.pdf" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("filters, selects, and deletes runs from the runs table and its menus", async () => {
    const run = (id: string, overrides: Partial<PlaybookRun> = {}) => ({
      ...RUN,
      id,
      documentName: `${id}.docx`,
      playbookName: "Playbook A",
      ...overrides,
    });
    const flagged = run("flagged", {
      findings: [
        {
          id: "f-1",
          topicId: null,
          ruleId: "cap",
          ruleName: "Liability cap",
          status: "unacceptable",
          quote: "",
          location: "",
          analysis: "Uncapped.",
          suggestedText: "",
        },
      ],
    });
    const clean = run("clean", { reviewMode: "permissive" });
    const busy = run("busy", { status: "running", completedAt: null });
    vi.mocked(listAllPlaybookRuns).mockResolvedValue([flagged, clean, busy]);
    vi.mocked(deletePlaybookRun).mockResolvedValue(undefined);
    render(<PlaybooksPage />);
    await screen.findByRole("link", { name: "Playbook A" });
    await userEvent.click(screen.getByRole("button", { name: "Runs" }));
    const table = await screen.findByRole("table", { name: "Playbook runs" });
    const rows = () =>
      within(table)
        .getAllByRole("checkbox")
        .slice(1)
        .map((box) => box.getAttribute("aria-label"));
    expect(rows()).toEqual([
      "Select flagged.docx",
      "Select clean.docx",
      "Select busy.docx",
    ]);
    // The details sit together after the document, with a menu at the end.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent?.trim()),
    ).toEqual(["Document", "Playbook", "Outcome", "Scope", "Posture", "Run", "Actions"]);

    await userEvent.click(
      within(table).getByRole("button", { name: "Filter by outcome" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Has issues" }),
    );
    expect(rows()).toEqual(["Select flagged.docx"]);
    await userEvent.click(
      within(table).getByRole("button", { name: "Filter by outcome" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "All Outcomes" }),
    );

    // A running review offers no delete.
    fireEvent.contextMenu(
      within(table).getByRole("button", { name: "busy.docx" }).closest('[role="row"]')!,
    );
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await userEvent.keyboard("{Escape}");

    // Two selected rows share the toolbar's Actions menu.
    await userEvent.click(
      within(table).getByRole("checkbox", { name: "Select flagged.docx" }),
    );
    await userEvent.click(
      within(table).getByRole("checkbox", { name: "Select clean.docx" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete 2 runs" }),
    );
    // The list reloads after a delete, as History does; the server no longer
    // returns the deleted runs.
    vi.mocked(listAllPlaybookRuns).mockResolvedValue([busy]);
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Delete runs?" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    );
    await waitFor(() => expect(deletePlaybookRun).toHaveBeenCalledTimes(2));
    expect(vi.mocked(deletePlaybookRun).mock.calls.map(([id]) => id)).toEqual([
      "flagged",
      "clean",
    ]);
    await waitFor(() => expect(rows()).toEqual(["Select busy.docx"]));
  });

  it("retries only the runs left after a partly failed delete", async () => {
    const run = (id: string) => ({
      ...RUN,
      id,
      documentName: `${id}.docx`,
      playbookName: "Playbook A",
    });
    vi.mocked(listAllPlaybookRuns).mockResolvedValue([run("first"), run("second")]);
    vi.mocked(deletePlaybookRun)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    render(<PlaybooksPage />);
    await screen.findByRole("link", { name: "Playbook A" });
    await userEvent.click(screen.getByRole("button", { name: "Runs" }));
    const table = await screen.findByRole("table", { name: "Playbook runs" });
    await userEvent.click(
      within(table).getByRole("checkbox", { name: "Select first.docx" }),
    );
    await userEvent.click(
      within(table).getByRole("checkbox", { name: "Select second.docx" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete 2 runs" }),
    );
    vi.mocked(listAllPlaybookRuns).mockResolvedValue([run("second")]);
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Delete runs?" })).getByRole(
        "button",
        { name: "Delete" },
      ),
    );

    // The dialog stays open for the run that is left, and only it is retried.
    const retry = await screen.findByRole("dialog", { name: "Delete run?" });
    await userEvent.click(within(retry).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deletePlaybookRun).toHaveBeenCalledTimes(3));
    expect(vi.mocked(deletePlaybookRun).mock.calls.map(([id]) => id)).toEqual([
      "first",
      "second",
      "second",
    ]);
  });

  it("offers both ways to add a playbook", async () => {
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /New playbook/i }),
    );

    expect(
      await screen.findByRole("menuitem", { name: /Import from file/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /Start from scratch/i }),
    ).toBeInTheDocument();
  });

  it("asks for a new playbook's details, then opens its rules", async () => {
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /New playbook/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Start from scratch/i }),
    );

    const dialog = await screen.findByRole("dialog", { name: "New playbook" });
    const create = within(dialog).getByRole("button", { name: "Create" });
    // Only the name is required.
    expect(create).toBeDisabled();
    await userEvent.type(
      within(dialog).getByLabelText("Playbook name"),
      "  Supply terms ",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Represented party"),
      "Buyer",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Jurisdictions"),
      "England and Wales, New York",
    );
    // A personal workspace has no organisation to open it to.
    expect(
      within(dialog).queryByRole("group", { name: "Organisational Access" }),
    ).toBeNull();
    await userEvent.click(create);

    await waitFor(() =>
      expect(createPlaybook).toHaveBeenCalledWith(
        {
          name: "Supply terms",
          representedParty: "Buyer",
          documentTypes: [],
          jurisdictions: ["England and Wales", "New York"],
          description: "",
          visibility: "private",
        },
        "personal",
      ),
    );
    expect(navigation.push).toHaveBeenCalledWith("/playbooks/pb-new");
    expect(
      await screen.findByRole("region", { name: "Topics and rules" }),
    ).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "New playbook" })).toBeNull();
  });

  it("starts with flat rules and can group or ungroup an existing rule without losing its content", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("button", { name: /New playbook/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Start from scratch/i }),
    );
    await userEvent.type(
      await screen.findByLabelText("Playbook name"),
      "Untitled playbook",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    const sidebar = await screen.findByRole("region", {
      name: "Topics and rules",
    });
    expect(within(sidebar).queryByRole("textbox")).toBeNull();
    await userEvent.click(
      within(sidebar).getByRole("button", { name: "Add rule" }),
    );
    expect(screen.getByLabelText("Rule")).toHaveValue("New rule 2");
    await userEvent.type(
      screen.getByLabelText("Additional guidance"),
      "Keep this guidance",
    );
    await userEvent.click(
      within(sidebar).getByRole("button", { name: "Rules actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Add topic" }),
    );
    const topicName = screen.getByLabelText("Topic 1 name");
    await userEvent.clear(topicName);
    await userEvent.type(topicName, "Commercial terms");
    expect(screen.getByLabelText("Rule")).toHaveValue("New rule 2");
    // A rule goes into a topic by dragging, and out of it from its menu.
    const dragged = new Map<string, string>();
    const dataTransfer = {
      types: [] as string[],
      effectAllowed: "none",
      dropEffect: "none",
      setDragImage: vi.fn(),
      setData(type: string, value: string) {
        this.types.push(type);
        dragged.set(type, value);
      },
      getData: (type: string) => dragged.get(type) ?? "",
    };
    fireEvent.dragStart(
      within(sidebar).getByRole("button", { name: "New rule 2" }),
      { dataTransfer },
    );
    const topicRow = screen.getByLabelText("Topic 1 name").parentElement!;
    fireEvent.dragOver(topicRow, { dataTransfer });
    fireEvent.drop(topicRow, { dataTransfer });
    await userEvent.click(
      within(sidebar).getByRole("button", {
        name: "Collapse topic Commercial terms",
      }),
    );
    expect(
      within(sidebar).queryByRole("button", { name: "New rule 2" }),
    ).toBeNull();
    expect(
      within(sidebar).getByRole("button", { name: "Liability cap" }),
    ).toBeVisible();
    await userEvent.click(
      within(sidebar).getByRole("button", {
        name: "Expand topic Commercial terms",
      }),
    );
    await userEvent.click(
      within(sidebar).getByRole("button", { name: "Rule actions for New rule 2" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Move out of topic" }),
    );
    expect(
      within(sidebar).getByRole("button", { name: "New rule 2" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Additional guidance")).toHaveValue(
      "Keep this guidance",
    );
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(updatePlaybook).toHaveBeenLastCalledWith(
      "pb-new",
      expect.objectContaining({
        rules: [
          expect.objectContaining({ name: "Liability cap" }),
          expect.objectContaining({
            name: "New rule 2",
            guidance: "Keep this guidance",
          }),
        ],
        topics: [
          expect.objectContaining({ name: "Commercial terms", rules: [] }),
        ],
      }),
      expect.any(Object),
    );
    const row = (
      await screen.findByRole("link", { name: "Untitled playbook" })
    ).closest('[role="row"]')!;
    // Name, Creator, Access, Type, Represented, Jurisdiction, then Rules.
    expect(
      within(row as HTMLElement).getAllByRole("cell")[6],
    ).toHaveTextContent("2");
  });

  it("names both ways to begin when there are no playbooks", async () => {
    vi.mocked(listPlaybooks).mockResolvedValue([]);
    render(<PlaybooksPage />);

    expect(
      await screen.findByRole("button", { name: "Import" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("replaces the selected playbook from a dropped PDF", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(startPlaybookImport).mockResolvedValue(
      importAttempt({ filename: "updated.pdf", playbookId: "pb-a" }),
    );
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Replace from file/i }),
    );
    const field = screen.getByRole("region", { name: "Add document" });
    expect(screen.getByRole("button", { name: "Compile" })).toBeDisabled();
    fireEvent.drop(field, {
      dataTransfer: {
        types: ["Files"],
        files: [
          new File(["pdf"], "updated.pdf", { type: "application/pdf" }),
        ],
      },
    });
    expect(within(field).getByText("updated.pdf")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Compile" }));

    await waitFor(() =>
      expect(startPlaybookImport).toHaveBeenCalledWith(
        expect.any(File),
        TEST_MODEL,
        "",
        "pb-a",
        "personal",
      ),
    );
    await pollImports();
    await waitFor(() =>
      expect(screen.queryByText("Compiling your playbook")).toBeNull(),
    );

    // The replacement rewrites a playbook; it must not add a second row.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Playbook actions" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Edit details" }),
    );
    expect(await screen.findByDisplayValue("Replaced")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    const rows = await screen.findAllByRole("link", { name: /Replaced/i });
    expect(rows).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Playbook A/i })).toBeNull();
  });

  it("imports a new playbook from a saved PDF", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({ status: "running", stage: "compiling" }),
    );
    vi.mocked(getPlaybook).mockResolvedValue(playbook("pb-new", "Standards"));
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /New playbook/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Import from file/i }),
    );
    // A saved .txt cannot be compiled, so it is refused and nothing is chosen.
    await userEvent.click(
      screen.getByRole("button", { name: /Drag and drop a Word or PDF playbook/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Choose saved contract" }),
    );
    expect(
      await screen.findByText("Choose a Word (.docx) or PDF playbook."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compile" })).toBeDisabled();

    await userEvent.click(
      screen.getByRole("button", { name: /Drag and drop a Word or PDF playbook/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Choose saved playbook" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Compile" }));

    await waitFor(() =>
      expect(startPlaybookImport).toHaveBeenCalledWith(
        { documentId: "saved-playbook" },
        TEST_MODEL,
        "",
        undefined,
        "personal",
      ),
    );
    // While compiling, the dialog shows only its progress screen.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Compiling your playbook",
    );
    expect(screen.queryByRole("button", { name: "Compile" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Add document" })).toBeNull();

    // Still compiling: the screen stays.
    await pollImports();
    expect(within(dialog).getByRole("status")).toBeInTheDocument();

    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({ status: "completed", playbookId: "pb-new" }),
    );
    await pollImports();
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith("/playbooks/pb-new"),
    );
    expect(screen.queryByText("Compiling your playbook")).toBeNull();
  });

  it("keeps compiling after the dialog is closed and says when it is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getPlaybookImport).mockResolvedValue(importAttempt());
    vi.mocked(getPlaybook).mockResolvedValue(playbook("pb-new", "Standards"));
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /New playbook/i }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Import from file/i }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Drag and drop a Word or PDF playbook/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Choose saved playbook" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Compile" }));
    // The footer's Close, not the header's icon: both leave it compiling.
    const footer = (await screen.findByRole("dialog")).querySelector("footer");
    await userEvent.click(
      within(footer!).getByRole("button", { name: "Close" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    // It compiles in a loading row of the table, not a notice above it.
    const table = screen.getByRole("table", { name: "Playbooks" });
    const row = within(table).getByRole("row", { busy: true });
    expect(row).toHaveTextContent("Standards");
    expect(row).toHaveTextContent("Compiling…");
    expect(within(row).queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("list", { name: "Playbooks being compiled" })).toBeNull();

    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({ status: "completed", playbookId: "pb-new" }),
    );
    await pollImports();
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "New playbook ready",
          message: "Standards has been compiled. Open to view.",
        }),
      ),
    );
    // Closing detached it, so the page stays where it is.
    expect(navigation.push).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(within(table).queryByRole("row", { busy: true })).toBeNull(),
    );
    expect(
      await screen.findByRole("link", { name: "Standards" }),
    ).toBeInTheDocument();
  });

  it("shows a replacement compiling in its playbook's own row", async () => {
    vi.mocked(listRunningPlaybookImports).mockResolvedValue([
      importAttempt({ name: "Playbook A", playbookId: "pb-a" }),
    ]);
    render(<PlaybooksPage />);
    const link = await screen.findByRole("link", { name: "Playbook A" });
    const row = link.closest('[role="row"]') as HTMLElement;
    expect(await within(row).findByRole("status")).toHaveTextContent(
      "Compiling…",
    );
    // No second row for it.
    expect(screen.queryByRole("row", { busy: true })).toBeNull();
  });

  /** Replaces Playbook A from a dropped PDF, then closes the dialog. */
  async function replacePlaybookA() {
    vi.mocked(startPlaybookImport).mockResolvedValue(
      importAttempt({ filename: "updated.pdf", playbookId: "pb-a" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Replace from file/i }),
    );
    fireEvent.drop(screen.getByRole("region", { name: "Add document" }), {
      dataTransfer: {
        types: ["Files"],
        files: [new File(["pdf"], "updated.pdf", { type: "application/pdf" })],
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Compile" }));
    const footer = (await screen.findByRole("dialog")).querySelector("footer");
    const close = within(footer!).getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toBeEnabled());
    await userEvent.click(close);
  }

  it("keeps a playbook read-only while its replacement compiles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({ playbookId: "pb-a" }),
    );
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await replacePlaybookA();
    await pollImports();

    // Closing the dialog detached it; the replacement still holds the rules.
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Liability cap" }),
    );
    expect(screen.getByLabelText("Rule")).toBeDisabled();
    expect(screen.getByRole("button", { name: "New rule" })).toBeDisabled();

    // Leaving and coming back does not reopen it for editing.
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Liability cap" }),
    );
    expect(screen.getByLabelText("Rule")).toBeDisabled();
    expect(updatePlaybook).not.toHaveBeenCalled();
  });

  it("does not save an edit over the rules a replacement wrote", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({ playbookId: "pb-a" }),
    );
    // An autosave that answers only after the import has finished.
    let finishSave!: () => void;
    vi.mocked(updatePlaybook).mockImplementation(
      (id, content) =>
        new Promise((resolve) => {
          finishSave = () => resolve({ ...playbook(id, content.name), content });
        }),
    );
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await replacePlaybookA();
    await userEvent.click(
      screen.getByRole("button", { name: "Liability cap" }),
    );
    await userEvent.type(
      screen.getByLabelText("Concept to detect"),
      "Stale edit",
    );
    await act(() => vi.advanceTimersByTimeAsync(800));

    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({ status: "completed", playbookId: "pb-a" }),
    );
    await pollImports();
    await waitFor(() =>
      expect(screen.getAllByText("Replaced").length).toBeGreaterThan(0),
    );
    await act(async () => {
      finishSave?.();
      await vi.advanceTimersByTimeAsync(1000);
    });

    // The old rules plus the edit would have overwritten the replacement.
    expect(updatePlaybook).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("link", { name: "Replaced" }),
    ).toBeInTheDocument();
  });

  it("gives back the rules as they were when a replacement fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({ playbookId: "pb-a" }),
    );
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Liability cap" }),
    );
    await userEvent.type(
      screen.getByLabelText("Concept to detect"),
      "My edit",
    );
    await replacePlaybookA();
    expect(updatePlaybook).toHaveBeenCalledTimes(1);
    await userEvent.click(
      screen.getByRole("button", { name: "Liability cap" }),
    );
    expect(screen.getByLabelText("Concept to detect")).toBeDisabled();

    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({
        status: "failed",
        playbookId: "pb-a",
        error: "The selected model did not finish within 5 minutes.",
      }),
    );
    await pollImports();
    await waitFor(() =>
      expect(screen.getByLabelText("Concept to detect")).toBeEnabled(),
    );
    expect(screen.getByLabelText("Concept to detect")).toHaveValue("My edit");
    expect(screen.getByRole("button", { name: "New rule" })).toBeEnabled();
  });

  it("opens a playbook still being replaced read-only after a reload", async () => {
    vi.mocked(listRunningPlaybookImports).mockResolvedValue([
      importAttempt({ name: "Playbook A", playbookId: "pb-a" }),
    ]);
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Liability cap" }),
    );
    expect(screen.getByLabelText("Rule")).toBeDisabled();
    expect(screen.getByRole("button", { name: "New rule" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: /Replace from file/i }),
    ).toBeNull();
    expect(
      await screen.findByRole("menuitem", { name: "View details" }),
    ).toBeInTheDocument();
  });

  it("follows an import started before the page was opened", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(listRunningPlaybookImports).mockResolvedValue([
      importAttempt({ name: "Vendor standards" }),
    ]);
    vi.mocked(getPlaybookImport).mockResolvedValue(
      importAttempt({
        name: "Vendor standards",
        status: "failed",
        error: "The selected model did not finish within 5 minutes.",
      }),
    );
    render(<PlaybooksPage />);

    expect(
      await screen.findByRole("row", { busy: true }),
    ).toHaveTextContent("Vendor standards");
    await pollImports();
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: "error",
          message: "The selected model did not finish within 5 minutes.",
        }),
      ),
    );
    expect(screen.queryByRole("row", { busy: true })).toBeNull();
  });

  it("does not ask for a name when replacing", async () => {
    render(<PlaybooksPage />);

    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Replace from file/i }),
    );

    // Replacing from Word keeps the name; it remains editable in Details.
    expect(screen.queryByLabelText(/Playbook name \(optional\)/i)).toBeNull();
    expect(
      screen.getByRole("region", { name: "Add document" }),
    ).toBeInTheDocument();
  });
  it("selects rows without opening them and clears selection when switching tabs", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Select Playbook A" }),
    );
    expect(screen.queryByLabelText("Playbook name")).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Select all playbooks" }),
    ).toBePartiallyChecked();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Select all playbooks" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Select all playbooks" }),
    ).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Delete 2 playbooks" }),
    ).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      screen.getByRole("button", { name: "Shared with me" }),
    );
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(
      screen.getByRole("checkbox", { name: "Select all playbooks" }),
    ).not.toBeChecked();
  });

  it("offers the same actions from the toolbar and from each row", async () => {
    const menu = async (trigger: HTMLElement) => {
      await userEvent.click(trigger);
      const names = screen
        .getAllByRole("menuitem")
        .map((item) => item.textContent?.trim());
      await userEvent.keyboard("{Escape}");
      return names;
    };
    const single = ["Open", "Details", "Run", "People", "Delete"];
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "Select Playbook A" }),
    );

    // One selected playbook: its row and the toolbar offer the same menu.
    const toolbarActions = () =>
      screen.getByRole("button", { name: "Actions" });
    expect(await menu(toolbarActions())).toEqual(["Deselect rows", ...single]);
    expect(
      await menu(
        screen.getByRole("button", { name: "Actions for Playbook A" }),
      ),
    ).toEqual(["Deselect rows", ...single]);
    // A row outside the selection acts on that row alone.
    expect(
      await menu(
        screen.getByRole("button", { name: "Actions for Playbook B" }),
      ),
    ).toEqual(single);

    // Several selected: the toolbar and each selected row act on them all.
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Select Playbook B" }),
    );
    const several = ["Deselect rows", "Delete 2 playbooks"];
    expect(await menu(toolbarActions())).toEqual(several);
    expect(
      await menu(
        screen.getByRole("button", { name: "Actions for Playbook B" }),
      ),
    ).toEqual(several);
  });

  it("shows owned and shared playbooks in All and filters each personal tab", async () => {
    vi.mocked(listPlaybooks).mockResolvedValue([
      playbook("owned", "Owned guide"),
      {
        ...playbook("shared", "Shared guide"),
        canEdit: false,
        role: "viewer",
        isCreator: false,
        canManageAccess: false,
        userId: "someone-else",
      },
    ]);
    render(<PlaybooksPage />);
    await screen.findByRole("link", { name: "Owned guide" });
    const all = screen.getByRole("button", { name: "All" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "Shared guide" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "My playbooks" }));
    expect(screen.getByRole("link", { name: "Owned guide" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Shared guide" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Shared with me" }),
    );
    expect(screen.getByRole("link", { name: "Shared guide" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Owned guide" })).toBeNull();
    await userEvent.click(all);
    expect(screen.getByRole("link", { name: "Owned guide" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Shared guide" })).toBeVisible();
  });

  it("shows all, private, and public tabs in an organization workspace", async () => {
    workspace.workspaceId = "org-1";
    workspace.activeOrganization = { name: "Test firm" };
    vi.mocked(listPlaybooks).mockResolvedValue([
      playbook("private", "Private guide"),
      { ...playbook("public", "Public guide"), visibility: "organization" },
    ]);
    render(<PlaybooksPage />);
    await screen.findByRole("link", { name: "Private guide" });
    expect(listPlaybooks).toHaveBeenCalledWith("org-1");
    const all = screen.getByRole("button", { name: "All" });
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: "Public guide" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Private" }));
    expect(screen.getByRole("link", { name: "Private guide" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Public guide" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Public" }));
    expect(
      screen.getByRole("link", { name: "Public guide" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Private guide" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Shared with me" })).toBeNull();
    await userEvent.click(all);
    expect(screen.getByRole("link", { name: "Private guide" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Public guide" })).toBeVisible();
  });

  it("switches between the rules and the Word file the playbook came from", async () => {
    vi.mocked(listPlaybookSources).mockResolvedValue([
      {
        id: "src-1",
        filename: "Data policy.pdf",
        fileType: "pdf",
        sizeBytes: 1200,
        createdAt: "2026-10-17T01:00:00.000Z",
      },
    ]);
    vi.mocked(listPlaybooks).mockResolvedValue([
      {
        ...playbook("imported", "Imported guide"),
        canEdit: false,
        role: "viewer",
        isCreator: false,
        canManageAccess: false,
        userId: "someone-else",
        sourceFilename: "Negotiation guide.docx",
      },
    ]);
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Imported guide" }),
    );
    const views = screen.getByRole("group", { name: "Playbook view" });
    expect(
      within(views).getByRole("button", { name: "Rules" }),
    ).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(
      within(views).getByRole("button", { name: "References" }),
    );
    expect(screen.queryByLabelText("Rule")).toBeNull();
    expect(screen.queryByRole("button", { name: "New rule" })).toBeNull();
    expect(
      within(
        screen.getByRole("region", { name: "Reference documents" }),
      ).getByRole("button", { name: "Negotiation guide.docx" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("document", { name: "Viewing Negotiation guide.docx" }),
    ).toHaveAttribute("data-url", "/api/playbooks/imported/source");
    expect(
      await screen.findByRole("button", { name: "Data policy.pdf" }),
    ).toBeInTheDocument();
    expect(listPlaybookSources).toHaveBeenCalledWith("imported");
    // A reader can open the documents but not add or remove them.
    expect(
      screen.queryByRole("button", { name: "Add reference document" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Upload" })).toBeDisabled();

    await userEvent.click(within(views).getByRole("button", { name: "Rules" }));
    expect(screen.getByLabelText("Rule")).toHaveValue("Liability cap");
  });

  it("uploads a reference document from the References toolbar", async () => {
    vi.mocked(listPlaybookSources).mockResolvedValue([]);
    const click = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {});
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "References" }));

    await userEvent.click(screen.getByRole("button", { name: "Upload" }));

    const input = click.mock.contexts[0] as HTMLInputElement;
    expect(input).toHaveAttribute("type", "file");
    click.mockRestore();
  });

  it("lets a shared reader browse the rules without editing them", async () => {
    vi.mocked(listPlaybooks).mockResolvedValue([
      {
        ...playbook("shared", "Shared guide"),
        canEdit: false,
        role: "viewer",
        isCreator: false,
        canManageAccess: false,
        userId: "someone-else",
      },
    ]);
    render(<PlaybooksPage />);
    await userEvent.click(
      screen.getByRole("button", { name: "Shared with me" }),
    );
    await userEvent.click(
      await screen.findByRole("link", { name: "Shared guide" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Liability cap" }),
    );
    expect(screen.getByLabelText("Rule")).toBeDisabled();
    expect(screen.getByRole("button", { name: "New rule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use" })).toBeEnabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Playbook actions" }),
    );
    expect(
      screen.queryByRole("menuitem", { name: /Replace from file/i }),
    ).toBeNull();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "View details" }),
    );
    const details = await screen.findByRole("dialog", { name: "Details" });
    for (const label of [
      "Playbook name",
      "Represented party",
      "Document types",
      "Jurisdictions",
      "Description",
    ]) {
      expect(within(details).getByLabelText(label)).toBeDisabled();
    }
    expect(
      within(details).queryByRole("button", { name: "Update" }),
    ).toBeNull();
  });

  it("offers saved files in the review footer", async () => {
    vi.mocked(getDocumentFile).mockResolvedValue({
      blob: new Blob(["Saved contract"]),
      filename: "saved.txt",
    });
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    await openNewRun();
    // Clicking the empty area opens the dialog for saved files or uploads.
    await userEvent.click(
      screen.getByRole("button", { name: /Drag and drop PDF, DOCX, or TXT files here/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Choose saved contract" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() =>
      expect(getDocumentFile).toHaveBeenCalledWith("saved-1", "doc-version"),
    );
    await waitFor(() =>
      expect(reviewDocumentWithPlaybook).toHaveBeenCalledWith(
        "pb-a",
        expect.objectContaining({ documentName: "saved.txt" }),
      ),
    );
  });
  it("adds multiple dropped documents as removable tiles and appends uploads without duplicates", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await openNewRun();
    const area = screen.getByRole("region", { name: "Add documents" });
    const one = new File(["First contract"], "one.txt", { type: "text/plain" });
    const two = new File(["Second contract"], "two.txt", {
      type: "text/plain",
    });
    expect(
      within(area)
        .getByRole("button", { name: /Drag and drop PDF, DOCX, or TXT files here/ })
        .querySelector("svg"),
    ).toBeNull();
    fireEvent.dragEnter(area, { dataTransfer: { types: ["Files"] } });
    expect(within(area).getByText("Drop documents to add them")).toBeVisible();
    fireEvent.drop(area, { dataTransfer: { files: [one, two] } });
    expect(within(area).getAllByRole("listitem")).toHaveLength(2);
    dropReviewFiles([
      one,
      new File(["Third"], "three.txt", { type: "text/plain" }),
    ]);
    expect(within(area).getAllByRole("listitem")).toHaveLength(3);
    await userEvent.click(
      within(area).getByRole("button", { name: "Remove two.txt" }),
    );
    expect(within(area).queryByText("two.txt")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start 2 reviews" }),
    ).toBeEnabled();
  });

  it("rejects unsupported dropped files without discarding valid documents", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await openNewRun();
    const area = screen.getByRole("region", { name: "Add documents" });
    fireEvent.drop(area, {
      dataTransfer: {
        files: [
          new File(["Contract"], "contract.txt"),
          new File(["Image"], "image.png"),
        ],
      },
    });
    expect(within(area).getAllByRole("listitem")).toHaveLength(1);
    expect(within(area).getByText("contract.txt")).toBeVisible();
    expect(within(area).queryByText("image.png")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Some files weren’t added. Choose PDF, DOCX, or TXT documents.",
    );
    await userEvent.click(
      within(area).getByRole("button", { name: "Remove contract.txt" }),
    );
    expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled();
  });

  it("reviews every uploaded and saved document separately and shows all completed runs", async () => {
    const completed: PlaybookRun[] = [];
    vi.mocked(listPlaybookRuns).mockImplementation(async () => [...completed]);
    vi.mocked(reviewDocumentWithPlaybook).mockImplementation(
      async (playbookId, payload) => {
        const result = {
          ...RUN,
          id: `run-${payload.documentName}`,
          playbookId,
          documentName: payload.documentName!,
        };
        completed.push(result);
        return result;
      },
    );
    vi.mocked(getDocumentFile).mockImplementation(async (id) => ({
      blob: new File([`Saved ${id}`], "saved.txt"),
      filename: id === "saved-1" ? "saved.txt" : "another-saved.txt",
    }));
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await openNewRun();
    dropReviewFiles([
      new File(["Uploaded one"], "one.txt"),
      new File(["Uploaded two"], "two.txt"),
    ]);
    // With documents already added, the area still offers the dialog.
    await userEvent.click(
      screen.getByRole("button", {
        name: "Drop more documents here, or click to add more.",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Choose saved contracts" }),
    );
    expect(
      within(
        screen.getByRole("region", { name: "Add documents" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(4);
    await userEvent.click(
      screen.getByRole("button", { name: "Start 4 reviews" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "New run" })).toBeNull(),
    );
    expect(reviewDocumentWithPlaybook).toHaveBeenCalledTimes(4);
    expect(
      vi
        .mocked(reviewDocumentWithPlaybook)
        .mock.calls.map(([id, payload]) => [
          id,
          payload.documentName,
          payload.documentText,
        ]),
    ).toEqual([
      ["pb-a", "one.txt", "Uploaded one"],
      ["pb-a", "two.txt", "Uploaded two"],
      ["pb-a", "saved.txt", "Saved saved-1"],
      ["pb-a", "another-saved.txt", "Saved saved-2"],
    ]);
    expect(getDocumentFile).toHaveBeenCalledWith("saved-2", "doc-version-2");
    const runs = screen.getByRole("region", { name: "Your runs" });
    for (const name of ["one.txt", "two.txt", "saved.txt", "another-saved.txt"])
      expect(await within(runs).findByRole("button", { name })).toBeVisible();
  });

  it("continues after a failed document and retries only that document", async () => {
    let finishFirst!: (run: PlaybookRun) => void;
    vi.mocked(reviewDocumentWithPlaybook)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("private provider error"))
      .mockResolvedValueOnce({
        ...RUN,
        id: "third-run",
        documentName: "three.txt",
      })
      .mockResolvedValueOnce({
        ...RUN,
        id: "retried-run",
        documentName: "two.txt",
      });
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await openNewRun();
    dropReviewFiles(["one", "two", "three"].map((name) => new File([name], `${name}.txt`)),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Start 3 reviews" }),
    );
    const area = screen.getByRole("region", { name: "Add documents" });
    await waitFor(() =>
      expect(reviewDocumentWithPlaybook).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(
      within(area).getByRole("button", { name: "Remove two.txt" }),
    ).toBeDisabled();
    fireEvent.drop(area, {
      dataTransfer: { files: [new File(["extra"], "extra.txt")] },
    });
    expect(within(area).getAllByRole("listitem")).toHaveLength(3);
    finishFirst({ ...RUN, id: "first-run", documentName: "one.txt" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Retry failed documents" }),
      ).toBeEnabled(),
    );
    expect(reviewDocumentWithPlaybook).toHaveBeenCalledTimes(3);
    // Each document is a pill whose status reads after its name.
    expect(within(area).getAllByTitle(/ · Started$/)).toHaveLength(2);
    expect(within(area).getByTitle(/ · Couldn’t start$/)).toBeVisible();
    // The failure is explained below the pills, without the raw error.
    expect(within(area).getByRole("alert")).toBeVisible();
    expect(within(area).queryByText(/private provider error/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Retry failed documents" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "New run" })).toBeNull(),
    );
    expect(
      vi
        .mocked(reviewDocumentWithPlaybook)
        .mock.calls.map(([, payload]) => payload.documentName),
    ).toEqual(["one.txt", "two.txt", "three.txt", "two.txt"]);
  });

  it("stores an uploaded contract and reviews a Word file by its document", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await openNewRun();
    dropReviewFiles([
      new File(["word"], "supply.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      new File(["Plain contract"], "notes.txt", { type: "text/plain" }),
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Start 2 reviews" }),
    );

    await waitFor(() =>
      expect(reviewDocumentWithPlaybook).toHaveBeenCalledTimes(2),
    );
    expect(uploadLibraryDocument).toHaveBeenCalledWith(
      { kind: "files", workspace: "personal" },
      expect.objectContaining({ name: "supply.docx" }),
    );
    // The server reads the Word file itself, so it can add tracked changes.
    expect(reviewDocumentWithPlaybook).toHaveBeenCalledWith(
      "pb-a",
      expect.objectContaining({
        documentId: "stored-supply.docx",
        documentText: undefined,
        documentName: "supply.docx",
      }),
    );
    expect(reviewDocumentWithPlaybook).toHaveBeenCalledWith(
      "pb-a",
      expect.objectContaining({
        documentId: "stored-notes.txt",
        documentText: "Plain contract",
      }),
    );
  });

  it("waits for pending edits before reviewing", async () => {
    let finishSave!: (book: Playbook) => void;
    vi.mocked(updatePlaybook).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.type(
      screen.getByLabelText("Concept to detect"),
      "Updated",
    );
    await openNewRun();
    dropReviewFiles(new File(["Contract"], "contract.txt", { type: "text/plain" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Start review" }));
    await waitFor(() =>
      expect(updatePlaybook).toHaveBeenCalledWith("pb-a", expect.any(Object), {
        visibility: "private",
      }),
    );
    expect(reviewDocumentWithPlaybook).not.toHaveBeenCalled();
    finishSave(playbook("pb-a", "Playbook A"));
    await waitFor(() => expect(reviewDocumentWithPlaybook).toHaveBeenCalled());
  });
  it("manages people from the header", async () => {
    vi.mocked(getPlaybookPeople).mockResolvedValue({
      scope: "direct",
      owner: {
        user_id: "u1",
        email: "owner@example.com",
        display_name: "Olive Owner",
      },
      members: [
        {
          email: "reader@example.com",
          display_name: "Rae Reader",
          role: "viewer",
        },
      ],
    });
    vi.mocked(listPlaybookShares).mockResolvedValue([
      {
        id: "share-1",
        shared_with_email: "reader@example.com",
        role: "viewer",
      },
    ]);
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    expect(screen.queryByLabelText("Share with")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Playbook people" }),
    );
    expect(await screen.findByText("Rae Reader")).toBeInTheDocument();
    expect(getPlaybookPeople).toHaveBeenCalledWith("pb-a");
    expect(listPlaybookShares).toHaveBeenCalledWith("pb-a");
  });
  it("selects another rule after deletion and offers to add one when none remain", async () => {
    render(<PlaybooksPage />);
    await userEvent.click(
      await screen.findByRole("link", { name: "Playbook A" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Topic actions for Liability" }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Add rule" }));
    expect(screen.getByLabelText("Rule")).toHaveValue("New rule 2");
    await userEvent.click(screen.getByRole("button", { name: "Rule actions" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete rule" }),
    );
    expect(screen.getByLabelText("Rule")).toHaveValue("Liability cap");
    expect(
      screen.getByRole("button", { name: "Liability cap" }),
    ).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Rule actions" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Delete rule" }),
    );
    expect(screen.getByText("No rules yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("Playbook name")).toBeNull();
    await userEvent.click(
      within(screen.getByRole("region", { name: "Rule editor" })).getByRole(
        "button",
        { name: "Add" },
      ),
    );
    expect(screen.getByLabelText("Rule")).toHaveValue("New rule 1");
  });
});
