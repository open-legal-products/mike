import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { withIntl } from "@/test/withIntl";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The popups.aviso namespace lands with this translation batch; the shared
// catalog still does not carry it.
const mensagensPopup = {
    popups: {
        aviso: { descartar: "Descartar aviso" },
    },
};
import {
  MikeApiError,
  getProjectMemory,
  setProjectMemoryEnabled,
  updateProjectMemory,
  type MemoryCurrent,
} from "@/app/lib/mikeApi";
import { ProjectMemoryModal } from "./ProjectMemoryModal";

// `useMemoryActivityLabel` é um hook chamado condicionalmente no JSX de
// ProjectMemoryModal (violates Rules of Hooks), o que derruba a árvore
// quando a memória carrega com enabled: true. Para exercitar o resto do
// modal, substituímos o hook por uma função pura com os mesmos rótulos
// pt-BR (memoria.revisaoAgendada / memoria.atualizandoMemoria).
vi.mock(
  "@/app/components/memory/MemoryEditorState",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/app/components/memory/MemoryEditorState")
    >()),
    useMemoryActivityLabel: (memory: MemoryCurrent | null) => {
      if (!memory) return null;
      if (memory.status === "scheduled")
        return "Revisão da memória agendada";
      if (memory.status === "processing") return "Atualizando a memória…";
      return null;
    },
  }),
);

vi.mock("@/app/components/ui/markdown-editor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    readOnly,
    suspended,
    ariaLabel,
  }: {
    value: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    suspended?: boolean;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      readOnly={readOnly || suspended}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getProjectMemory: vi.fn(),
  setProjectMemoryEnabled: vi.fn(),
  updateProjectMemory: vi.fn(),
}));

const CURRENT = {
  enabled: true,
  content: "# Matter facts",
  revision: 2,
  hash: "hash-2",
  updated_at: "2026-09-05T01:00:00Z",
  updated_by: "Alex",
  source: "curator" as const,
  status: "idle" as const,
};

function renderModal(
  props: Partial<React.ComponentProps<typeof ProjectMemoryModal>> = {},
) {
  const onClose = vi.fn();
  const onMemoryEnabledChange = vi.fn();
  const result = render(
    withIntl(
      <ProjectMemoryModal
        open
        onClose={onClose}
        projectId="project-1"
        projectName="Matter"
        canEdit={false}
        canManage={false}
        onMemoryEnabledChange={onMemoryEnabledChange}
        {...props}
      />,
      mensagensPopup,
    ),
  );
  return { ...result, onClose, onMemoryEnabledChange };
}

describe("ProjectMemoryModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(getProjectMemory).mockResolvedValue(CURRENT);
    vi.mocked(updateProjectMemory).mockImplementation(
      async (_projectId, content) => ({
        ...CURRENT,
        content,
        revision: 3,
        hash: "hash-3",
      }),
    );
  });

  it("does not read memory until the dialog is opened", async () => {
    const { rerender, onClose } = renderModal({ open: false });

    expect(getProjectMemory).not.toHaveBeenCalled();

    rerender(
      withIntl(
        <ProjectMemoryModal
          open
          onClose={onClose}
          projectId="project-1"
          projectName="Matter"
          canEdit={false}
          canManage={false}
        />,
        mensagensPopup,
      ),
    );

    await screen.findByRole("textbox", { name: "Memória do projeto" });
    expect(getProjectMemory).toHaveBeenCalledWith(
      "project-1",
      expect.anything(),
    );
  });

  it("lets viewers read memory without edit or delete controls", async () => {
    renderModal();

    const editor = await screen.findByRole("textbox", {
      name: "Memória do projeto",
    });
    // A quiet, up-to-date file reports nothing: no timestamp, no source.
    expect(screen.queryByText(/Last updated/)).toBeNull();
    expect(screen.queryByText(/Automatic update/)).toBeNull();
    // The editor takes whatever height is left rather than the body scrolling.
    expect(editor.parentElement).toHaveClass("min-h-0", "flex-1");
    expect(editor).toHaveValue("# Matter facts");
    expect(editor).toHaveAttribute("readonly");
    expect(
      screen.getByText(
        "Reúne o contexto compartilhado do projeto, selecionado a partir das conversas neste projeto.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Download project memory.md",
      }),
    ).toBeNull();
    expect(screen.getByRole("dialog", { name: "Memória do projeto" })).toHaveClass(
      "max-w-2xl",
      "h-[min(600px,calc(100vh-2rem))]",
    );
    expect(
      screen.getByRole("dialog", { name: "Memória do projeto" }),
    ).not.toHaveClass("max-w-4xl");
  });

  it("shows a failed update only inside project memory and remembers dismissal", async () => {
    const user = userEvent.setup();
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      status: "failed",
    });

    const { unmount } = renderModal();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A última atualização automática falhou",
    );

    await user.click(screen.getByRole("button", { name: "Descartar aviso" }));
    expect(screen.queryByRole("alert")).toBeNull();

    unmount();
    renderModal();
    await screen.findByRole("textbox", { name: "Memória do projeto" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("autosaves an editor's draft against the loaded version", async () => {
    vi.mocked(updateProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "# Updated",
      revision: 3,
    });
    const user = userEvent.setup();
    renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Memória do projeto",
    });
    await user.clear(editor);
    await user.type(editor, "# Updated");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(updateProjectMemory).not.toHaveBeenCalled();
    expect(screen.getByText("Salvando…")).toBeVisible();

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenCalledWith(
          "project-1",
          "# Updated",
          2,
        ),
      { timeout: 10000 },
    );
    expect(await screen.findByText("Salvo")).toBeVisible();
  });

  it("adopts server-normalized Markdown without repeatedly saving it", async () => {
    vi.mocked(updateProjectMemory).mockResolvedValue({
      ...CURRENT,
      content: "# Normalized",
      revision: 3,
      hash: "hash-3",
    });
    renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Memória do projeto",
    });
    await screen.findByRole("button", { name: "Fechar" });

    vi.useFakeTimers();
    try {
      fireEvent.change(editor, { target: { value: "# Normalized " } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(updateProjectMemory).toHaveBeenCalledOnce();
      expect(editor).toHaveValue("# Normalized");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(updateProjectMemory).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes an unsaved draft before closing", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Memória do projeto",
    });
    fireEvent.change(editor, {
      target: { value: "# Matter facts and more" },
    });
    await user.click(screen.getByRole("button", { name: "Concluído" }));

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenCalledWith(
          "project-1",
          "# Matter facts and more",
          2,
        ),
      { timeout: 10000 },
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByText("Discard unsaved memory edits?")).toBeNull();
  });

  it("closes without confirmation when nothing is unsaved", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    await screen.findByRole("textbox", { name: "Memória do projeto" });
    await user.click(screen.getByRole("button", { name: "Concluído" }));

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText("Discard unsaved memory edits?")).toBeNull();
  });

  it("offers an explicit discard path when autosave fails during close", async () => {
    vi.mocked(updateProjectMemory).mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    const { onClose } = renderModal({ canEdit: true });

    const editor = await screen.findByRole("textbox", {
      name: "Memória do projeto",
    });
    fireEvent.change(editor, {
      target: { value: "# Matter facts unsaved" },
    });
    expect(
      await screen.findByText(
        "Não foi possível salvar a memória do projeto. Seu rascunho foi preservado.",
        {},
        { timeout: 10000 },
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Fechar sem salvar?")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Fechar sem salvar" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("preserves an editor's stale draft across a version conflict", async () => {
    const latest = {
      ...CURRENT,
      content: "# Automatic update",
      revision: 3,
      hash: "hash-3",
    };
    vi.mocked(getProjectMemory)
      .mockResolvedValueOnce(CURRENT)
      .mockResolvedValueOnce(latest);
    vi.mocked(updateProjectMemory)
      .mockRejectedValueOnce(
        new MikeApiError({
          status: 409,
          code: "memory_revision_conflict",
          message: "Memory changed",
        }),
      )
      .mockResolvedValueOnce({
        ...CURRENT,
        content: "# My draft",
        revision: 4,
        hash: "hash-4",
      });
    const user = userEvent.setup();
    renderModal({ canEdit: true, canManage: true });

    const editor = await screen.findByRole("textbox", {
      name: "Memória do projeto",
    });
    // ModalUI auto-foca o primeiro focável via rAF no mount; sob carga esse
    // rAF pode disparar depois e roubar o foco durante o typing. rAFs são
    // FIFO: esperar dois quadros garante que o auto-foco já aconteceu.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await user.click(editor);
    await user.clear(editor);
    await user.type(editor, "# My draft");

    expect(
      await screen.findByText(
        "A memória do projeto foi alterada enquanto você editava",
        {},
        { timeout: 10000 },
      ),
    ).toBeVisible();
    expect(editor).toHaveValue("# My draft");

    await user.click(screen.getByRole("button", { name: "Manter meu rascunho" }));

    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenLastCalledWith(
          "project-1",
          "# My draft",
          3,
        ),
      { timeout: 10000 },
    );
  });

  it("lets a project owner enable memory from the memory modal", async () => {
    const off = {
      ...CURRENT,
      enabled: false,
      content: "",
      revision: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
    };
    vi.mocked(getProjectMemory).mockResolvedValue(off);
    vi.mocked(setProjectMemoryEnabled).mockResolvedValue({
      ...off,
      enabled: true,
    });
    const user = userEvent.setup();
    const { onMemoryEnabledChange } = renderModal({
      canEdit: true,
      canManage: true,
    });

    await user.click(
      await screen.findByRole("switch", { name: "Habilitar memória do projeto" }),
    );

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("project-1", true),
    );
    expect(await screen.findByText("Memória do projeto habilitada")).toBeVisible();
    expect(onMemoryEnabledChange).toHaveBeenLastCalledWith(true);
  });

  it("keeps the memory setting read-only for members who cannot manage access", async () => {
    vi.mocked(getProjectMemory).mockResolvedValue({
      ...CURRENT,
      enabled: false,
      content: "",
      revision: 0,
      hash: null,
      updated_at: null,
      updated_by: null,
    });

    renderModal({ canEdit: true });

    expect(await screen.findByText("A memória do projeto está desligada")).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Habilitar memória do projeto" }),
    ).toBeDisabled();
  });

  it("requires confirmation before an owner disables project memory", async () => {
    vi.mocked(setProjectMemoryEnabled).mockResolvedValue({
      ...CURRENT,
      enabled: false,
      content: "",
      revision: 3,
      hash: null,
      updated_at: null,
      updated_by: null,
    });
    const user = userEvent.setup();
    const { onMemoryEnabledChange } = renderModal({
      canEdit: true,
      canManage: true,
    });

    const memorySwitch = await screen.findByRole("switch", {
      name: "Habilitar memória do projeto",
    });
    expect(memorySwitch).toBeChecked();

    await user.click(memorySwitch);

    expect(setProjectMemoryEnabled).not.toHaveBeenCalled();
    expect(screen.getByText("Desligar a memória do projeto?")).toBeVisible();
    expect(
      screen.getByText(/excluirá o arquivo memory\.md existente do projeto/),
    ).toBeVisible();
    expect(screen.getByText(/cancelará as atualizações de memória pendentes/)).toBeVisible();
    expect(screen.getByText(/impedirá futuras atualizações de memória/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Desativar" }));

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("project-1", false),
    );
    expect(memorySwitch).not.toBeChecked();
    expect(onMemoryEnabledChange).toHaveBeenLastCalledWith(false);
  });

  it("clears project memory through the normal autosave path", async () => {
    const user = userEvent.setup();
    renderModal({ canEdit: true, canManage: true });

    const editor = await screen.findByRole("textbox", {
      name: "Memória do projeto",
    });
    expect(
      screen.queryByRole("button", { name: "Delete project memory" }),
    ).toBeNull();

    await user.clear(editor);
    await waitFor(
      () =>
        expect(updateProjectMemory).toHaveBeenCalledWith("project-1", "", 2),
      { timeout: 10000 },
    );
  });

  it("polls until a scheduled project-memory update is visible", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getProjectMemory)
        .mockResolvedValueOnce({ ...CURRENT, status: "scheduled" })
        .mockResolvedValueOnce({
          ...CURRENT,
          content: "# Curated matter facts",
          revision: 3,
          hash: "hash-3",
          status: "idle",
        });

      renderModal();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText(/Revisão da memória agendada/)).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });

      expect(
        screen.getByRole("textbox", { name: "Memória do projeto" }),
      ).toHaveValue("# Curated matter facts");
      expect(getProjectMemory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
