import { render, screen, waitFor, within } from "@testing-library/react";
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
      await screen.findByRole("menuitem", { name: "Add to templates" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Added Order Form.docx to templates.",
      ),
    );
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

  it("adds every file in a publisher folder and reports a failure without claiming success", async () => {
    vi.mocked(addPresetTemplate)
      .mockResolvedValueOnce({ id: "copy-1" } as never)
      .mockRejectedValueOnce(new Error("backend detail"));
    render(<PresetTemplatesPage />);
    await openRowMenu("Common Paper");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /^Add \d+ to templates$/ }),
    );

    expect(await screen.findByRole("alert")).not.toHaveTextContent(
      "backend detail",
    );
    expect(screen.getByRole("status")).toHaveTextContent(/^Added 1 of \d+ files\.$/);
    expect(addPresetTemplate).toHaveBeenCalledTimes(2);
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
      screen.queryByRole("menuitem", { name: "Add to templates" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "View" }),
    ).not.toBeInTheDocument();
  });
});
