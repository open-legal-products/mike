import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowList } from "./WorkflowList";

const {
  activeTab,
  getWorkflowFilterOptions,
  importWorkflowAddon,
  listWorkflowAddons,
  retryWorkflows,
  routerPush,
  setActiveTab,
  usePaginatedWorkflowsSpy,
  workflowRows,
} = vi.hoisted(() => ({
  activeTab: { current: "addons" },
  getWorkflowFilterOptions: vi.fn(),
  importWorkflowAddon: vi.fn(),
  setActiveTab: vi.fn(),
  listWorkflowAddons: vi.fn(),
  retryWorkflows: vi.fn(),
  routerPush: vi.fn(),
  usePaginatedWorkflowsSpy: vi.fn(),
  workflowRows: { current: [] as Record<string, unknown>[] },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("@/app/hooks/useQueryParamTab", () => ({
  useQueryParamTab: () => [activeTab.current, setActiveTab],
}));

vi.mock("@/app/hooks/usePaginatedWorkflows", () => ({
  usePaginatedWorkflows: (options: unknown) => {
    usePaginatedWorkflowsSpy(options);
    const [selectedWorkflowIds, setSelectedWorkflowIds] = useState<string[]>([]);
    return {
      dbWorkflows: workflowRows.current,
      setDbWorkflows: vi.fn(),
      loading: false,
      loadingMore: false,
      hasMore: false,
      error: null,
      loadMoreError: null,
      loadMore: vi.fn(),
      retry: retryWorkflows,
      selectedWorkflowIds,
      setSelectedWorkflowIds,
      selectAllMatching: vi.fn(),
      selectingAll: false,
    };
  },
}));

vi.mock("@/app/lib/mikeApi", () => ({
  deleteWorkflow: vi.fn(),
  getWorkflowFilterOptions,
  getWorkflowAddon: vi.fn(),
  importWorkflowAddon,
  listWorkflowAddons,
}));

vi.mock("./UseWorkflowModal", () => ({
  UseWorkflowModal: () => null,
}));

vi.mock("./NewWorkflowModal", () => ({
  NewWorkflowModal: ({
    open,
    onClose,
  }: {
    open: boolean;
    onClose: (createdWithoutHandoff?: boolean) => void;
  }) =>
    open ? (
      <div>
        <button type="button" onClick={() => onClose(true)}>
          Dismiss after partial create
        </button>
        <button type="button" onClick={() => onClose(false)}>
          Dismiss without creating
        </button>
      </div>
    ) : null,
}));

vi.mock("./WorkflowAddonPreviewModal", () => ({
  WorkflowAddonPreviewModal: () => null,
}));

const packAddons = [1, 2, 3].map((index) => ({
  id: `pack-addon-${index}`,
  addon_key: `workflow-${index}`,
  pack_key: index === 3 ? "other-pack" : "starter-pack",
  pack_title: index === 3 ? "Other pack" : "Starter pack",
  pack_description: null,
  title: `Pack workflow ${index}`,
  type: "assistant",
  description: "Test workflow",
  language: "English",
  practice: "General",
  jurisdictions: ["General"],
}));

describe("WorkflowList pack toolbar", () => {
  beforeEach(() => {
    activeTab.current = "addons";
    workflowRows.current = [];
    setActiveTab.mockReset();
    getWorkflowFilterOptions.mockReset();
    listWorkflowAddons.mockReset();
    importWorkflowAddon.mockReset();
    retryWorkflows.mockReset();
    routerPush.mockReset();
    usePaginatedWorkflowsSpy.mockReset();
    listWorkflowAddons.mockReturnValue(new Promise(() => {}));
    getWorkflowFilterOptions.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  });

  it.each([1, 2])("matches toolbar and right-click actions for %i selected workflows", async (count) => {
    const user = userEvent.setup();
    activeTab.current = "all";
    workflowRows.current = [1, 2].map((index) => ({
      id: `workflow-${index}`, user_id: "user-1", is_owner: true,
      metadata: { title: `Workflow ${index}`, type: "assistant" },
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    }));
    render(<WorkflowList />);
    await user.click(screen.getByRole("checkbox", { name: "Select Workflow 1" }));
    if (count === 2) await user.click(screen.getByRole("checkbox", { name: "Select Workflow 2" }));
    await user.click(screen.getByRole("button", { name: "Actions" }));
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(items).toEqual(count === 1 ? ["View", "Edit", "Delete"] : ["Delete 2 workflows"]);
    await user.keyboard("{Escape}");
    fireEvent.contextMenu(screen.getByText("Workflow 1"), { clientX: 40, clientY: 40 });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(items);
  });

  it("replaces workflow tabs with Back on the left inside a pack", async () => {
    const user = userEvent.setup();
    render(<WorkflowList initialTab="addons" packKey="legal-starter" />);

    const back = screen.getByText("Back").closest("button");
    expect(back).not.toBeNull();
    if (!back) throw new Error("Pack toolbar Back button was not rendered");
    const toolbar = back.closest(".h-10");

    expect(toolbar).not.toBeNull();
    expect(back.parentElement).toHaveClass("flex-1");
    expect(back.parentElement).not.toHaveClass("ml-auto");
    expect(
      within(toolbar as HTMLElement).queryByText("All"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Assistant"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Tabular"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Add-ons"),
    ).not.toBeInTheDocument();

    await user.click(back);
    expect(setActiveTab).toHaveBeenCalledWith("addons", "/workflows/addons");
  });

  it("uses an icon row import action and keeps the bulk import pill", async () => {
    const user = userEvent.setup();
    listWorkflowAddons.mockResolvedValue([
      {
        id: "addon-1",
        addon_key: "draft-from-precedent",
        pack_key: null,
        pack_title: null,
        pack_description: null,
        pack_version: null,
        version: "1.0.0",
        title: "Draft from precedent",
        description: "Draft using a precedent.",
        type: "assistant",
        prompt_md: "Draft from the precedent.",
        contributors: [],
        language: "English",
        practice: "General Transactions",
        jurisdictions: ["General"],
        active: true,
        updated_at: "2026-08-28T00:00:00.000Z",
        assets: [],
      },
    ]);

    render(<WorkflowList initialTab="addons" />);

    const rowImport = await screen.findByRole("button", { name: "Import" });
    expect(rowImport).not.toHaveClass("bg-gray-950/88");
    expect(rowImport).toHaveTextContent("");
    expect(rowImport.querySelector("svg")).not.toBeNull();

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes.at(-1)!);

    const importButtons = screen.getAllByRole("button", { name: "Import" });
    expect(importButtons).toHaveLength(2);
    // The bulk action is the toolbar's standard pill, not a black one.
    expect(
      importButtons.filter(
        (button) => button.dataset.slot === "tab-pill-button",
      ),
    ).toHaveLength(1);
    expect(
      importButtons.filter((button) =>
        button.classList.contains("bg-gray-950/88"),
      ),
    ).toHaveLength(0);
  });

  it("offers View and Import from an add-on row's right-click menu", async () => {
    const user = userEvent.setup();
    listWorkflowAddons.mockResolvedValue([
      {
        id: "addon-1",
        addon_key: "draft-from-precedent",
        pack_key: null,
        pack_title: null,
        pack_description: null,
        pack_version: null,
        version: "1.0.0",
        title: "Draft from precedent",
        description: "Draft using a precedent.",
        type: "assistant",
        prompt_md: "Draft from the precedent.",
        contributors: [],
        language: "English",
        practice: "General Transactions",
        jurisdictions: ["General"],
        active: true,
        updated_at: "2026-08-28T00:00:00.000Z",
        assets: [],
      },
    ]);
    importWorkflowAddon.mockResolvedValue({
      id: "workflow-1",
      user_id: "user-1",
      metadata: {
        title: "Draft from precedent",
        type: "assistant",
        contributors: [],
        language: "English",
      },
      is_system: false,
    });

    render(<WorkflowList initialTab="addons" />);
    await user.pointer({
      keys: "[MouseRight]",
      target: await screen.findByText("Draft from precedent"),
    });

    expect(
      await screen.findByRole("menuitem", { name: "View" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Import" }));

    expect(importWorkflowAddon).toHaveBeenCalledWith("addon-1");
    expect(
      await screen.findByRole("button", { name: "Imported" }),
    ).toBeInTheDocument();
  });

  it("shows Imported with a green tick and stays on Add-ons", async () => {
    const user = userEvent.setup();
    listWorkflowAddons.mockResolvedValue([
      {
        id: "addon-1",
        addon_key: "draft-from-precedent",
        pack_key: null,
        pack_title: null,
        pack_description: null,
        pack_version: null,
        version: "1.0.0",
        title: "Draft from precedent",
        description: "Draft using a precedent.",
        type: "assistant",
        prompt_md: "Draft from the precedent.",
        contributors: [],
        language: "English",
        practice: "General Transactions",
        jurisdictions: ["General"],
        active: true,
        updated_at: "2026-08-28T00:00:00.000Z",
        assets: [],
      },
    ]);
    importWorkflowAddon.mockResolvedValue({
      id: "workflow-1",
      user_id: "user-1",
      metadata: {
        title: "Draft from precedent",
        type: "assistant",
        contributors: [],
        language: "English",
      },
      is_system: false,
    });

    render(<WorkflowList initialTab="addons" />);
    await user.click(await screen.findByRole("button", { name: "Import" }));

    const imported = await screen.findByRole("button", { name: "Imported" });
    expect(imported).toHaveClass("text-green-600");
    expect(imported.querySelector("svg")).not.toBeNull();
    expect(imported).toBeDisabled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("imports a folder from its plus button and shows progress without opening it", async () => {
    const user = userEvent.setup();
    listWorkflowAddons.mockResolvedValue(packAddons);
    let finish!: (value: unknown) => void;
    importWorkflowAddon
      .mockResolvedValueOnce({ id: "copy-1" })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<WorkflowList initialTab="addons" />);
    const folder = (await screen.findByText("Starter pack")).closest(".group") as HTMLElement;
    const otherFolder = screen.getByText("Other pack").closest(".group") as HTMLElement;
    const button = within(folder).getByRole("button", { name: "Import" });
    expect(button).toHaveClass("h-6", "w-6");
    expect(button.querySelector("svg")).toHaveClass("lucide-plus");
    await user.click(button);

    const pending = within(folder).getByRole("button", { name: "Importing…" });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending.querySelector("svg")).toHaveClass("animate-spin");
    expect(within(otherFolder).getByRole("button", { name: "Import" })).toBeDisabled();
    expect(importWorkflowAddon.mock.calls.map(([id]) => id)).toEqual(["pack-addon-1", "pack-addon-2"]);
    expect(setActiveTab).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.queryByText("Pack workflow 1")).not.toBeInTheDocument();

    await act(async () => finish({ id: "copy-2" }));
    const imported = within(folder).getByRole("button", { name: "Imported" });
    expect(imported).toHaveClass("text-green-600");
    expect(imported).toBeDisabled();
    expect(within(otherFolder).getByRole("button", { name: "Import" })).toBeEnabled();
  });

  it("retries a partially imported folder without copying successful workflows again", async () => {
    const user = userEvent.setup();
    listWorkflowAddons.mockResolvedValue(packAddons);
    importWorkflowAddon
      .mockResolvedValueOnce({ id: "copy-1" })
      .mockRejectedValueOnce(new Error("Import failed"));
    render(<WorkflowList initialTab="addons" />);
    const folder = (await screen.findByText("Starter pack")).closest(".group") as HTMLElement;
    await user.click(within(folder).getByRole("button", { name: "Import" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Some selected add-ons could not be imported.");
    expect(within(folder).queryByRole("button", { name: "Imported" })).not.toBeInTheDocument();

    importWorkflowAddon.mockResolvedValueOnce({ id: "copy-2" });
    await user.click(within(folder).getByRole("button", { name: "Import" }));
    expect(await within(folder).findByRole("button", { name: "Imported" })).toBeDisabled();
    expect(importWorkflowAddon.mock.calls.map(([id]) => id)).toEqual(["pack-addon-1", "pack-addon-2", "pack-addon-2"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows resource access scopes in the workflows table", () => {
    activeTab.current = "all";
    workflowRows.current = [
      {
        id: "private-workflow",
        user_id: "user-1",
        access_scope: "private",
        metadata: {
          title: "Private workflow",
          type: "assistant",
          contributors: [],
          language: "English",
          practice: null,
          jurisdictions: null,
        },
        is_system: false,
      },
      {
        id: "shared-workflow",
        user_id: "user-1",
        access_scope: "shared",
        direct_grant_count: 1,
        metadata: {
          title: "Shared workflow",
          type: "assistant",
          contributors: [],
          language: "English",
          practice: null,
          jurisdictions: null,
        },
        is_system: false,
      },
      {
        id: "org-workflow",
        user_id: "user-1",
        access_scope: "organization",
        organization_name: "Elite Law LLP",
        metadata: {
          title: "Firm workflow",
          type: "assistant",
          contributors: [],
          language: "English",
          practice: null,
          jurisdictions: null,
        },
        is_system: false,
      },
    ];

    render(<WorkflowList />);

    expect(screen.getByText("Access")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("2 users")).toBeInTheDocument();
    expect(screen.getByText("Elite Law LLP")).toBeInTheDocument();
    expect(screen.getByTitle("Shared with Elite Law LLP")).toBeVisible();
  });

  it("filters Private and Shared from the Access column header", async () => {
    const user = userEvent.setup();
    activeTab.current = "all";
    render(<WorkflowList />);

    await user.click(
      screen.getByRole("button", { name: "Filter by access" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Shared" }));

    const calls = usePaginatedWorkflowsSpy.mock.calls;
    expect(calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ scope: "collaborative" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Filter by access" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Private" }));
    expect(usePaginatedWorkflowsSpy.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ scope: "private" }),
    );
  });

  it("refetches when the new-workflow modal is dismissed after a partial create", async () => {
    const user = userEvent.setup();
    activeTab.current = "all";
    // The workflow exists on the server but never reached onCreated, so only
    // a refetch can put its row in the list.
    retryWorkflows.mockImplementation(() => {
      workflowRows.current = [
        {
          id: "created-workflow",
          user_id: "user-1",
          access_scope: "private",
          metadata: {
            title: "Created workflow",
            type: "assistant",
            contributors: [],
            language: "English",
            practice: null,
            jurisdictions: null,
          },
          is_system: false,
        },
      ];
    });
    render(<WorkflowList />);

    expect(screen.queryByText("Created workflow")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New workflow" }));
    await user.click(
      screen.getByRole("button", { name: "Dismiss after partial create" }),
    );

    expect(retryWorkflows).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Created workflow")).toBeVisible();
  });

  it("does not refetch when the new-workflow modal is dismissed with nothing created", async () => {
    const user = userEvent.setup();
    activeTab.current = "all";
    render(<WorkflowList />);

    await user.click(screen.getByRole("button", { name: "New workflow" }));
    await user.click(
      screen.getByRole("button", { name: "Dismiss without creating" }),
    );

    expect(retryWorkflows).not.toHaveBeenCalled();
  });
});
