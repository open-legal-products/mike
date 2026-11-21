import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkflowAddon } from "../shared/types";
import { WorkflowAddonPreviewModal } from "./WorkflowAddonPreviewModal";

vi.mock("../modals/Modal", () => ({
  Modal: ({
    children,
    secondaryAction,
  }: {
    children: React.ReactNode;
    secondaryAction?: {
      label: React.ReactNode;
      onClick?: () => void;
    };
  }) => (
    <div>
      {children}
      {secondaryAction && (
        <button type="button" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </button>
      )}
    </div>
  ),
}));

vi.mock("../shared/views/PdfView", () => ({
  PdfView: ({ displayUrl }: { displayUrl: string }) => (
    <div data-testid="pdf-view">{displayUrl}</div>
  ),
}));

vi.mock("../shared/views/SpreadsheetView", () => ({
  SpreadsheetView: ({
    displayUrl,
    fileActions,
  }: {
    displayUrl: string;
    fileActions?: boolean;
  }) => (
    <div
      data-testid="spreadsheet-view"
      data-file-actions={String(fileActions ?? true)}
    >
      {displayUrl}
    </div>
  ),
}));

function addon(assets: WorkflowAddon["assets"]): WorkflowAddon {
  return {
    id: "addon-1",
    addon_key: "draft-from-precedent",
    pack_key: null,
    pack_title: null,
    pack_description: null,
    pack_version: null,
    version: "1.0.0",
    title: "Draft from precedent",
    description: "Draft using the included precedent.",
    type: "assistant",
    prompt_md: "# Draft from precedent\nUse the reference.",
    contributors: [
      { name: "Mike", organisation: null, role: null, linkedin: null },
    ],
    language: "English",
    practice: "General Transactions",
    jurisdictions: ["General"],
    active: true,
    updated_at: "2026-08-28T00:00:00.000Z",
    assets,
  };
}

describe("WorkflowAddonPreviewModal", () => {
  it("shows the add-on's assets in its details", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowAddonPreviewModal
        addon={addon([
          {
            id: "reference-1",
            filename: "Precedent.docx",
            file_type: "docx",
            size_bytes: 42,
            created_at: "2026-08-28T00:00:00.000Z",
          },
        ])}
        importing={false}
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );

    const assetsTab = screen.getByRole("button", { name: "Assets" });
    await user.click(assetsTab);

    expect(assetsTab).toHaveAttribute("aria-pressed", "true");
    expect(assetsTab).toHaveClass("h-7", "rounded-full");
    expect(screen.getByText("Precedent.docx")).toBeVisible();
    const assetButton = screen.getByRole("button", {
      name: /Precedent\.docx/,
    });
    expect(assetButton.querySelector("img")).toHaveClass("h-4", "w-4");
  });

  it("expands long descriptions", async () => {
    const user = userEvent.setup();
    const longDescription = "A".repeat(220);
    render(
      <WorkflowAddonPreviewModal
        addon={{ ...addon([]), description: longDescription }}
        importing={false}
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle.parentElement?.tagName).toBe("P");
    expect(screen.queryByText(longDescription)).not.toBeInTheDocument();

    await user.click(toggle);

    expect(screen.getByText(longDescription)).toBeVisible();
    expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it.each([
    ["Precedent.docx", "docx", "pdf-view"],
    ["Report.pdf", "pdf", "pdf-view"],
    ["Model.xlsx", "xlsx", "spreadsheet-view"],
    ["Deck.pptx", "pptx", "pdf-view"],
  ])(
    "opens %s in the matching in-modal viewer",
    async (filename, fileType, testId) => {
      const user = userEvent.setup();
      render(
        <WorkflowAddonPreviewModal
          addon={addon([
            {
              id: "reference-1",
              filename,
              file_type: fileType,
              size_bytes: 42,
              created_at: "2026-08-28T00:00:00.000Z",
            },
          ])}
          importing={false}
          onClose={vi.fn()}
          onImport={vi.fn()}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Assets" }));
      await user.click(
        screen.getByRole("button", {
          name: new RegExp(filename.replace(".", "\\.")),
        }),
      );

      expect(screen.getByTestId(testId)).toHaveTextContent(
        "/workflow-addons/addon-1/assets/reference-1/display",
      );
      expect(screen.getByRole("button", { name: "Back" })).toBeVisible();

      await user.click(screen.getByRole("button", { name: "Back" }));

      expect(screen.queryByTestId(testId)).not.toBeInTheDocument();
      expect(screen.getByText(filename)).toBeVisible();
    },
  );

  it("tells the spreadsheet preview the modal has no download or upload", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowAddonPreviewModal
        addon={addon([
          {
            id: "reference-1",
            filename: "Model.xlsx",
            file_type: "xlsx",
            size_bytes: 42,
            created_at: "2026-08-28T00:00:00.000Z",
          },
        ])}
        importing={false}
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Assets" }));
    await user.click(screen.getByRole("button", { name: /Model\.xlsx/ }));

    expect(screen.getByTestId("spreadsheet-view")).toHaveAttribute(
      "data-file-actions",
      "false",
    );
  });

  it("hides the assets tab when an assistant add-on has no assets", () => {
    render(
      <WorkflowAddonPreviewModal
        addon={addon([])}
        importing={false}
        onClose={vi.fn()}
        onImport={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Assets" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("SKILL.md")).toBeVisible();
  });
});
