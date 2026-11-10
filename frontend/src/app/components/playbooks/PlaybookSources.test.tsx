import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts } from "@/app/components/ui/toast";
import type { PlaybookSupplementarySource } from "@/app/lib/mikeApi";
import { PlaybookSources } from "./PlaybookSources";

const api = vi.hoisted(() => ({
  listPlaybookSources: vi.fn(),
  uploadPlaybookSource: vi.fn(),
  addPlaybookSourceFromDocument: vi.fn(),
  deletePlaybookSource: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", async (original) => ({
  ...(await original<typeof import("@/app/lib/mikeApi")>()),
  ...api,
}));
const viewers = vi.hoisted(() => ({ docx: vi.fn(), pdf: vi.fn() }));
vi.mock("@/app/components/shared/views/DocxView", () => ({
  DocxView: (props: Record<string, unknown>) => {
    viewers.docx(props);
    return <div role="document" aria-label={`Viewing ${props.filename}`} />;
  },
}));
vi.mock("@/app/components/shared/views/PdfView", () => ({
  PdfView: (props: { displayUrl?: string }) => {
    viewers.pdf(props);
    return <div role="document" aria-label="Viewing PDF" />;
  },
}));
vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
  AddDocumentsModal: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onSelect: (documents: { id: string; filename: string }[]) => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSelect([
            { id: "doc-1", filename: "Template.docx" },
            { id: "doc-2", filename: "Notes.txt" },
          ])
        }
      >
        Pick template
      </button>
    ) : null,
}));

const policy: PlaybookSupplementarySource = {
  id: "src-1",
  filename: "Data policy.pdf",
  fileType: "pdf",
  sizeBytes: 1200,
  createdAt: "2026-10-17T01:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listPlaybookSources.mockResolvedValue([policy]);
});
afterEach(() => clearToasts());

describe("playbook sources", () => {
  it("lists the imported file and supplementary documents read-only for a viewer", async () => {
    render(
      <PlaybookSources
        playbookId="guide/one"
        sourceFilename="Negotiation guide.docx"
        revision="0"
      />,
    );
    const list = screen.getByRole("region", { name: "Reference documents" });
    expect(
      within(list).getByRole("button", { name: "Negotiation guide.docx" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(viewers.docx).toHaveBeenLastCalledWith(
      expect.objectContaining({
        displayUrl: "/api/playbooks/guide%2Fone/source",
        canEdit: false,
        toolbarVisible: false,
      }),
    );
    await userEvent.click(
      await within(list).findByRole("button", { name: "Data policy.pdf" }),
    );
    expect(viewers.pdf).toHaveBeenLastCalledWith(
      expect.objectContaining({
        displayUrl: "/api/playbooks/guide%2Fone/sources/src-1/file",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Add reference document" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Actions for Data policy.pdf" }),
    ).toBeNull();
  });

  it("uploads .docx and .pdf files and selects the new document", async () => {
    const added = { ...policy, id: "src-2", filename: "Retention.pdf" };
    api.uploadPlaybookSource.mockResolvedValue(added);
    const { container } = render(
      <PlaybookSources
        playbookId="pb"
        sourceFilename={null}
        revision="0"
        canEdit
      />,
    );
    await screen.findByRole("button", { name: "Data policy.pdf" });
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(
      input,
      [
        new File(["%PDF"], "Retention.pdf", { type: "application/pdf" }),
        new File(["x"], "notes.txt", { type: "text/plain" }),
      ],
      { applyAccept: false },
    );
    expect(api.uploadPlaybookSource).toHaveBeenCalledTimes(1);
    expect(api.uploadPlaybookSource.mock.calls[0][1].name).toBe(
      "Retention.pdf",
    );
    expect(
      await screen.findByRole("button", { name: "Retention.pdf" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("copies documents chosen from the library, skipping other file types", async () => {
    api.addPlaybookSourceFromDocument.mockResolvedValue({
      ...policy,
      id: "src-3",
      filename: "Template.docx",
      fileType: "docx",
    });
    render(
      <PlaybookSources
        playbookId="pb"
        sourceFilename={null}
        revision="0"
        canEdit
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Add reference document" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Choose from documents" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Pick template" }),
    );
    expect(api.addPlaybookSourceFromDocument).toHaveBeenCalledTimes(1);
    expect(api.addPlaybookSourceFromDocument).toHaveBeenCalledWith(
      "pb",
      "doc-1",
    );
    expect(
      await screen.findByRole("button", { name: "Template.docx" }),
    ).toBeInTheDocument();
  });

  it("removes a supplementary document after confirmation", async () => {
    api.deletePlaybookSource.mockResolvedValue(undefined);
    render(
      <PlaybookSources
        playbookId="pb"
        sourceFilename={null}
        revision="0"
        canEdit
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Actions for Data policy.pdf",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    expect(screen.getByText("Remove Data policy.pdf?")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(api.deletePlaybookSource).toHaveBeenCalledWith("pb", "src-1");
    expect(
      screen.queryByRole("button", { name: "Data policy.pdf" }),
    ).toBeNull();
    expect(screen.getByText("None yet.")).toBeVisible();
  });

  it("explains an empty playbook", async () => {
    api.listPlaybookSources.mockResolvedValue([]);
    render(
      <PlaybookSources playbookId="pb" sourceFilename={null} revision="0" />,
    );
    expect(await screen.findByText("None yet.")).toBeVisible();
    expect(screen.getByText("No reference documents")).toBeVisible();
    expect(screen.queryByRole("document")).toBeNull();
    // A viewer cannot add documents, so the placeholder offers no actions.
    expect(screen.queryByRole("button", { name: "Upload a file" })).toBeNull();
  });

  it("offers both ways to add a document from the empty placeholder", async () => {
    api.listPlaybookSources.mockResolvedValue([]);
    render(
      <PlaybookSources
        playbookId="pb"
        sourceFilename={null}
        revision="0"
        canEdit
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Upload a file" }),
    ).toBeVisible();

    await userEvent.click(
      screen.getByRole("button", { name: "Choose from documents" }),
    );

    expect(screen.getByRole("button", { name: "Pick template" })).toBeVisible();
  });
});
