import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PresetTemplatesPage } from "./PresetTemplatesPage";
import { addPresetTemplate } from "./presetTemplates";

const push = vi.fn();
const setDocumentsForKind = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));
vi.mock("./LibraryWorkspace", () => ({
  useLibraryWorkspace: () => ({
    collections: { files: null, templates: { documents: [], folders: [] } },
    setDocumentsForKind,
  }),
}));
vi.mock("./presetTemplates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./presetTemplates")>()),
  addPresetTemplate: vi.fn(),
}));
vi.mock("@/app/components/shared/DocumentSidePanel", () => ({
  DocumentSidePanel: ({
    doc,
    displayUrl,
    readOnly,
  }: {
    doc: { filename: string } | null;
    displayUrl?: string | null;
    readOnly?: boolean;
  }) =>
    doc ? (
      <output data-testid="side-panel" data-read-only={String(readOnly)}>
        {displayUrl}
      </output>
    ) : null,
}));

function rowLabel(name: string) {
  return screen.getByText(name);
}

async function openRowMenu(name: string) {
  const row = rowLabel(name).closest("[data-collection-row-key]");
  await userEvent.click(
    within(row as HTMLElement).getByRole("button", {
      name: "Open row actions",
    }),
  );
}

describe("preset templates page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(addPresetTemplate).mockReset();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
  });

  it("lists each publisher library as a folder and previews its files read-only", async () => {
    render(<PresetTemplatesPage />);
    for (const publisher of ["Bonterms", "Common Paper", "General Legal"]) {
      expect(rowLabel(publisher)).toBeInTheDocument();
    }
    expect(screen.queryByText("Order Form.docx")).not.toBeInTheDocument();

    await userEvent.click(rowLabel("Common Paper"));
    await userEvent.click(await screen.findByText("Order Form.docx"));

    const panel = screen.getByTestId("side-panel");
    expect(panel).toHaveTextContent(
      "/preset-templates/Common%20Paper/Order%20Form.docx",
    );
    expect(panel).toHaveAttribute("data-read-only", "true");
  });

  it("adds a copy to the Templates folder the presets were opened from", async () => {
    vi.mocked(addPresetTemplate).mockResolvedValue({
      id: "personal-copy",
    } as never);
    render(<PresetTemplatesPage folderId="my-folder" />);
    await userEvent.click(rowLabel("Common Paper"));
    await screen.findByText("Order Form.docx");
    await openRowMenu("Order Form.docx");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Import" }),
    );

    const imported = await screen.findByRole("menuitem", { name: "Imported" });
    expect(imported).toHaveAttribute("aria-disabled", "true");
    expect(imported.querySelector("svg")).toHaveClass("text-green-600");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(addPresetTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "Common Paper/Order Form.docx" }),
      "my-folder",
      expect.any(AbortSignal),
    );
    expect(setDocumentsForKind).toHaveBeenCalledWith(
      "templates",
      expect.any(Function),
    );
    expect(
      screen.queryByRole("menuitem", { name: /rename|delete/i }),
    ).not.toBeInTheDocument();
  });

  it("retains completed files after a partial folder import and retries only the remaining files", async () => {
    vi.mocked(addPresetTemplate)
      .mockResolvedValueOnce({ id: "copy-1" } as never)
      .mockRejectedValueOnce(new Error("backend detail"));
    render(<PresetTemplatesPage />);
    await openRowMenu("Common Paper");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /^Import \d+$/ }),
    );

    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "backend detail",
    );
    expect(screen.queryByRole("menuitem", { name: "Imported" })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(addPresetTemplate).toHaveBeenCalledTimes(2);
    const firstPreset = vi.mocked(addPresetTemplate).mock.calls[0][0];
    vi.mocked(addPresetTemplate).mockResolvedValue({ id: "copy-next" } as never);
    await userEvent.click(screen.getByRole("menuitem", { name: /^Import \d+$/ }));
    expect(await screen.findByRole("menuitem", { name: "Imported" })).toBeVisible();
    expect(vi.mocked(addPresetTemplate).mock.calls.filter(([preset]) => preset.id === firstPreset.id)).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["row", "context", "selection"] as const)("shows live import progress in the %s menu and prevents duplicate requests", async (menu) => {
    let finish!: (document: Awaited<ReturnType<typeof addPresetTemplate>>) => void;
    vi.mocked(addPresetTemplate).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<PresetTemplatesPage />);
    await userEvent.click(rowLabel("Common Paper"));
    const filename = await screen.findByText("Order Form.docx");
    if (menu === "selection") {
      const row = filename.closest("[data-collection-row-key]") as HTMLElement;
      await userEvent.click(within(row).getByRole("checkbox"));
      await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    } else if (menu === "context") {
      fireEvent.contextMenu(filename, { clientX: 40, clientY: 40 });
    } else {
      await openRowMenu("Order Form.docx");
    }
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import" }));
    const pending = await screen.findByRole("menuitem", { name: "Import…" });
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(pending).toHaveAttribute("aria-disabled", "true");
    expect(pending.querySelector("svg")).toHaveClass("animate-spin");
    fireEvent.click(pending);
    expect(addPresetTemplate).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    await act(async () => finish({ id: "personal-copy" } as never));
    const imported = await screen.findByRole("menuitem", { name: "Imported" });
    expect(imported).toHaveAttribute("aria-disabled", "true");
    expect(imported.querySelector("svg")).toHaveClass("text-green-600");
    fireEvent.click(imported);
    expect(addPresetTemplate).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    await openRowMenu("Order Form.docx");
    expect(await screen.findByRole("menuitem", { name: "Imported" })).toBeVisible();
  });

  it("keeps a multi-file selection pending until every file is imported", async () => {
    let finish!: (document: Awaited<ReturnType<typeof addPresetTemplate>>) => void;
    vi.mocked(addPresetTemplate)
      .mockResolvedValueOnce({ id: "copy-1" } as never)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<PresetTemplatesPage />);
    await userEvent.click(rowLabel("Common Paper"));
    await userEvent.click(await screen.findByLabelText("Select Amendment.docx"));
    await userEvent.click(screen.getByLabelText("Select Order Form.docx"));
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Import 2" }));

    expect(await screen.findByRole("menuitem", { name: "Import…" })).toHaveAttribute("aria-busy", "true");
    expect(addPresetTemplate).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("menuitem", { name: "Imported" })).not.toBeInTheDocument();
    await act(async () => finish({ id: "copy-2" } as never));
    expect(await screen.findByRole("menuitem", { name: "Imported" })).toHaveAttribute("aria-disabled", "true");
  });

  it("offers a Markdown reference for download only", async () => {
    render(<PresetTemplatesPage />);
    for (const folder of [
      "General Legal",
      "Agent-Operated Company Formation Package",
      "filing-instructions",
    ]) {
      await userEvent.click(await screen.findByText(folder));
    }
    await screen.findByText("delaware.md");
    await openRowMenu("delaware.md");
    expect(
      await screen.findByRole("menuitem", { name: "Download" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Import" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "View" }),
    ).not.toBeInTheDocument();
  });
});
