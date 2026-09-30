import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PresetTemplatesModal } from "./PresetTemplatesModal";
import { addPresetTemplate } from "./presetTemplates";

vi.mock("./presetTemplates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./presetTemplates")>()),
  addPresetTemplate: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", () => ({
  uploadLibraryDocument: vi.fn(),
  MikeApiError: class extends Error {},
}));

function renderModal() {
  const onImported = vi.fn();
  const view = render(
    <PresetTemplatesModal
      open
      onClose={vi.fn()}
      folderId="my-folder"
      onImported={onImported}
    />,
  );
  return { onImported, ...view };
}

describe("preset template picker", () => {
  beforeEach(() => vi.resetAllMocks());

  it("filters by publisher and package/name, preserving source links and downloads", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "General Legal" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search presets" }),
      { target: { value: "bylaws" } },
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(
      within(rows[0]).getByRole("link", { name: "General Legal" }),
    ).toHaveAttribute("href", "https://general.legal/library");
    expect(
      within(rows[0]).getByRole("link", { name: "Download" }),
    ).toHaveAttribute("download", "bylaws-ccorp.docx");
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "no such agreement" },
    });
    expect(
      screen.getByText("No presets match your search."),
    ).toBeInTheDocument();
  });

  it("imports to the selected folder once and reports the returned personal copy", async () => {
    let finish!: (document: unknown) => void;
    vi.mocked(addPresetTemplate).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve as typeof finish;
        }),
    );
    const { onImported } = renderModal();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "bylaws" },
    });
    const add = screen.getByRole("button", { name: "Add to templates" });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(addPresetTemplate).toHaveBeenCalledTimes(1);
    expect(addPresetTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "bylaws-ccorp.docx" }),
      "my-folder",
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
    await act(async () => finish({ id: "my-copy" }));
    expect(onImported).toHaveBeenCalledWith({ id: "my-copy" });
    expect(screen.getByRole("button", { name: "Added" })).toBeDisabled();
  });

  it("shows a safe error and allows retry after upload failure", async () => {
    vi.mocked(addPresetTemplate).mockRejectedValueOnce(
      new Error("private database error"),
    );
    const { onImported } = renderModal();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "bylaws" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to templates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not add this preset. Please try again.",
    );
    expect(
      screen.queryByText("private database error"),
    ).not.toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
    vi.mocked(addPresetTemplate).mockResolvedValueOnce({
      id: "retry-copy",
    } as never);
    fireEvent.click(screen.getByRole("button", { name: "Add to templates" }));
    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith({ id: "retry-copy" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("provides downloads without upload controls for Markdown instructions", () => {
    renderModal();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: " md" },
    });
    expect(screen.getAllByRole("link", { name: "Download" })).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: "Add to templates" }),
    ).not.toBeInTheDocument();
  });
});
