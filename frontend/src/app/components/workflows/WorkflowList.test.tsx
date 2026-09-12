import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { WorkflowList } from "./WorkflowList";

const {
  activeTab,
  getWorkflowFilterOptions,
  importWorkflowAddon,
  listWorkflowAddons,
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
    return {
      dbWorkflows: workflowRows.current,
      setDbWorkflows: vi.fn(),
      loading: false,
      loadingMore: false,
      hasMore: false,
      error: null,
      loadMoreError: null,
      loadMore: vi.fn(),
      selectedWorkflowIds: [],
      setSelectedWorkflowIds: vi.fn(),
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
  NewWorkflowModal: () => null,
}));

vi.mock("./WorkflowAddonPreviewModal", () => ({
  WorkflowAddonPreviewModal: () => null,
}));

describe("WorkflowList pack toolbar", () => {
  beforeEach(() => {
    activeTab.current = "addons";
    workflowRows.current = [];
    setActiveTab.mockReset();
    getWorkflowFilterOptions.mockReset();
    listWorkflowAddons.mockReset();
    importWorkflowAddon.mockReset();
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

  it("replaces workflow tabs with Back on the left inside a pack", async () => {
    const user = userEvent.setup();
    render(withIntl(<WorkflowList initialTab="addons" packKey="legal-starter" />));

    const back = screen.getByText("Voltar").closest("button");
    expect(back).not.toBeNull();
    if (!back) throw new Error("Pack toolbar Back button was not rendered");
    const toolbar = back.closest(".h-10");

    expect(toolbar).not.toBeNull();
    expect(back.parentElement).toHaveClass("flex-1");
    expect(back.parentElement).not.toHaveClass("ml-auto");
    expect(
      within(toolbar as HTMLElement).queryByText("Todos"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Assistente"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Tabular"),
    ).not.toBeInTheDocument();
    expect(
      within(toolbar as HTMLElement).queryByText("Complementos"),
    ).not.toBeInTheDocument();

    await user.click(back);
    expect(setActiveTab).toHaveBeenCalledWith("addons", "/workflows/addons");
  });

  it("uses a plain row import action and keeps the bulk import pill", async () => {
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

    render(withIntl(<WorkflowList initialTab="addons" />));

    const rowImport = await screen.findByRole("button", { name: "Importar" });
    expect(rowImport).not.toHaveClass("bg-gray-950/88");
    expect(rowImport.querySelector("svg")).toBeNull();

    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes.at(-1)!);

    const importButtons = screen.getAllByRole("button", { name: "Importar" });
    expect(importButtons).toHaveLength(2);
    expect(
      importButtons.filter((button) =>
        button.classList.contains("bg-gray-950/88"),
      ),
    ).toHaveLength(1);
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

    render(withIntl(<WorkflowList initialTab="addons" />));
    await user.click(await screen.findByRole("button", { name: "Importar" }));

    const imported = await screen.findByRole("button", { name: "Importado" });
    expect(imported).toHaveClass("text-green-600");
    expect(imported.querySelector("svg")).not.toBeNull();
    expect(imported).toBeDisabled();
    expect(routerPush).not.toHaveBeenCalled();
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

    render(withIntl(<WorkflowList />));

    expect(screen.getByText("Acesso")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
    expect(screen.getByText("2 users")).toBeInTheDocument();
    expect(screen.getByText("Elite Law LLP")).toBeInTheDocument();
    expect(screen.getByTitle("Shared with Elite Law LLP")).toBeVisible();
  });

  it("filters Private and Shared from the Access column header", async () => {
    const user = userEvent.setup();
    activeTab.current = "all";
    render(withIntl(<WorkflowList />));

    await user.click(
      screen.getByRole("button", { name: "Filtrar por acesso" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Compartilhado" }));

    const calls = usePaginatedWorkflowsSpy.mock.calls;
    expect(calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ scope: "collaborative" }),
    );

    await user.click(
      screen.getByRole("button", { name: "Filtrar por acesso" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Privado" }));
    expect(usePaginatedWorkflowsSpy.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ scope: "private" }),
    );
  });
});
