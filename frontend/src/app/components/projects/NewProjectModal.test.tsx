import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    MikeApiError,
    createProject,
    grantProjectAccess,
    listOrgMembers,
    listOrgs,
    lookupUserByEmail,
  setProjectMemoryEnabled,
  uploadProjectDocuments,
} from "@/app/lib/mikeApi";
import { NewProjectModal } from "./NewProjectModal";
import { withIntl } from "@/test/withIntl";

const { useUserProfile } = vi.hoisted(() => ({
    useUserProfile: vi.fn(),
}));

// `importOriginal` keeps the real `MikeApiError`, which `userFacingApiError`
// recognises with `instanceof` — a stand-in would make the failure case pass
// for the wrong reason.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    createProject: vi.fn(),
    grantProjectAccess: vi.fn(),
    addDocumentToProject: vi.fn(),
    uploadProjectDocument: vi.fn(),
    listOrgs: vi.fn(),
    listOrgMembers: vi.fn(),
    lookupUserByEmail: vi.fn(),
  setProjectMemoryEnabled: vi.fn(),
  uploadProjectDocuments: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile,
}));
vi.mock("../shared/FileDirectory", () => ({ FileDirectory: () => null }));
vi.mock("./ProjectPracticeField", () => ({
    ProjectPracticeField: ({ id, value }: { id: string; value: string }) => (
        <button id={id} type="button">
            {value || "None"}
        </button>
    ),
}));

const CREATED = {
    id: "p1",
    name: "Matter",
    user_id: "me",
    cm_number: null,
    practice: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  memory_enabled: true,
};

async function fillAndAdd(
    user: ReturnType<typeof userEvent.setup>,
    email: string,
    role: string,
) {
    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "Matter");
    expect(
        screen.queryByPlaceholderText("Adicionar por e-mail…"),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Próximo" }));
    if (role !== "editor") {
        await user.click(
            screen.getByRole("button", { name: /Papel do novo destinatário/ }),
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: role[0].toUpperCase() + role.slice(1),
            }),
        );
    }
    await user.type(screen.getByPlaceholderText("Adicionar por e-mail…"), email);
    await user.click(screen.getByRole("button", { name: "Adicionar" }));
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
    if (!screen.queryByRole("button", { name: "Criar projeto" })) {
        const detailsNext = screen.getByRole("button", { name: "Próximo" });
        await waitFor(() => expect(detailsNext).toBeEnabled());
        await user.click(detailsNext);
    }
    if (!screen.queryByRole("button", { name: "Criar projeto" })) {
        await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Acesso" })).toBeVisible(),
        );
        expect(screen.getByText("Compartilhar acesso")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Próximo" }));
    }
    await user.click(
        await screen.findByRole("button", { name: "Criar projeto" }),
    );
}

function renderModal(onCreated = vi.fn()) {
    render(
        withIntl(<NewProjectModal open onClose={vi.fn()} onCreated={onCreated} />),
    );
    return onCreated;
}

describe("NewProjectModal sharing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listOrgs).mockResolvedValue([]);
        vi.mocked(listOrgMembers).mockResolvedValue([]);
        vi.mocked(createProject).mockResolvedValue(CREATED as never);
        vi.mocked(grantProjectAccess).mockResolvedValue({} as never);
    vi.mocked(setProjectMemoryEnabled).mockResolvedValue({
      enabled: false,
      content: "",
      revision: 1,
      hash: null,
      updated_at: null,
      updated_by: null,
      source: "settings",
      status: "idle",
    });
    vi.mocked(uploadProjectDocuments).mockResolvedValue([]);
        vi.mocked(lookupUserByEmail).mockImplementation(async (email) => ({
            exists: true,
            email,
            display_name: "Existing user",
        }));
        useUserProfile.mockReturnValue({
            profile: { practiceAreas: [], projectMemoryDefault: true },
        });
    });

    it("starts with the user's first preset practice area", async () => {
        useUserProfile.mockReturnValue({
            profile: {
                practiceAreas: ["Corporate and M&A", "Litigation"],
                projectMemoryDefault: true,
            },
        });
        renderModal();

        expect(
            await screen.findByLabelText("Área de prática"),
        ).toHaveTextContent(
            "Corporate and M&A",
        );
    });

  it("creates new projects with memory enabled by default", async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();

    expect(
      screen.getByRole("switch", { name: "Ativar memória do projeto" }),
    ).toBeChecked();
    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
  });

  it("follows the account's off default for new projects", async () => {
    useUserProfile.mockReturnValue({
      profile: { practiceAreas: [], projectMemoryDefault: false },
    });
    const user = userEvent.setup({ delay: null });
    renderModal();

    expect(
      screen.getByRole("switch", { name: "Ativar memória do projeto" }),
    ).not.toBeChecked();
    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        false,
      ),
    );
  });

  it("lets the creator override the account default for one project", async () => {
    useUserProfile.mockReturnValue({
      profile: { practiceAreas: [], projectMemoryDefault: false },
    });
    const user = userEvent.setup({ delay: null });
    renderModal();

    await user.click(
      screen.getByRole("switch", { name: "Ativar memória do projeto" }),
    );
    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
  });

  it("honours an explicit project-memory opt-out", async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();

    await user.click(
      screen.getByRole("switch", { name: "Ativar memória do projeto" }),
    );
    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        false,
      ),
    );
  });

    it("shares with an existing user at the chosen role", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

        await fillAndAdd(user, "outside@counsel.test", "viewer");
        await submit(user);

        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "outside@counsel.test",
                "viewer",
            ),
        );
        expect(lookupUserByEmail).toHaveBeenCalledWith("outside@counsel.test");
        expect(onCreated).toHaveBeenCalled();
    });

    it("does not add an email that has no Mike account", async () => {
        vi.mocked(lookupUserByEmail).mockResolvedValueOnce({
            exists: false,
            email: "future@firm.test",
            display_name: null,
        });
        const user = userEvent.setup({ delay: null });
        renderModal();

        await fillAndAdd(user, "future@firm.test", "viewer");

        expect(
            await screen.findByText(
                "future@firm.test não pertence a um usuário do Mike.",
            ),
        ).toBeInTheDocument();
        expect(grantProjectAccess).not.toHaveBeenCalled();
        expect(
            screen.queryByRole("button", { name: "Papel de future@firm.test" }),
        ).not.toBeInTheDocument();
    });

    it("hands the list a row that says the creator is its owner", async () => {
        // POST /projects returns a bare row with no role fields, and the
        // list's fail-closed roleFrom() reads that as viewer — so the
        // creator had no row menu, no Edit details and no Delete on the
        // project they just made until a refetch. The optimistic row must
        // say what the server will serve for it on every future load.
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();
        await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "P");
        await submit(user);

        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(onCreated).toHaveBeenCalledWith(
            expect.objectContaining({
                is_owner: true,
                access_role: "owner",
                access_scope: "private",
            }),
        );
    });

    it("does not create or redirect until document selection is finished", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "Matter");
        await user.click(screen.getByRole("button", { name: "Próximo" }));
        expect(screen.getByRole("dialog", { name: "Acesso" })).toBeVisible();
        expect(createProject).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const accessNext = screen.getByRole("button", { name: "Próximo" });
        expect(accessNext).toHaveAttribute("type", "button");
        await user.click(accessNext);
    expect(screen.getByRole("dialog", { name: "Adicionar Documentos" })).toBeVisible();
        expect(createProject).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const form = document.getElementById("new-project-modal-form");
        expect(form).not.toBeNull();
        fireEvent.submit(form!);
        expect(createProject).not.toHaveBeenCalled();

        const create = screen.getByRole("button", { name: "Criar projeto" });
        expect(create).toHaveAttribute("type", "button");
        await user.click(create);
        await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
        expect(onCreated).toHaveBeenCalled();
    });

    it("creates grants through the role-aware endpoint", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

        await fillAndAdd(user, "counsel@firm.test", "owner");
        await submit(user);

        await waitFor(() => expect(createProject).toHaveBeenCalled());
        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "counsel@firm.test",
                "owner",
            ),
        );
        expect(onCreated).toHaveBeenCalledWith(
            expect.objectContaining({
                access_scope: "shared",
                direct_grant_count: 1,
            }),
        );
    });

    it("gives each recipient their own role", { timeout: 15000 }, async () => {
        const user = userEvent.setup({ delay: null });
        renderModal();

        await fillAndAdd(user, "one@firm.test", "owner");
        await user.click(
            screen.getByRole("button", { name: /Papel do novo destinatário/ }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Viewer" }));
        await user.type(
            screen.getByPlaceholderText("Adicionar por e-mail…"),
            "two@firm.test",
        );
        await user.click(screen.getByRole("button", { name: "Adicionar" }));

        // Each row carries its own picker, and changing one leaves the other.
        await user.click(
            screen.getByRole("button", { name: "Papel de one@firm.test" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Editor" }));
        expect(
            screen.getByRole("button", { name: "Papel de two@firm.test" }),
        ).toHaveTextContent("Viewer");

        await submit(user);

        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "one@firm.test",
                "editor",
            ),
        );
        expect(grantProjectAccess).toHaveBeenCalledWith(
            "p1",
            "two@firm.test",
            "viewer",
        );
    });

    it("reports a refused grant and does not create a second project on retry", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();
        vi.mocked(grantProjectAccess).mockRejectedValueOnce(
            new MikeApiError({
                status: 400,
                message: "The project creator already has owner access",
            }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await submit(user);

        expect(
            await screen.findByText(
                /Projeto criado, mas o acesso não foi concedido a counsel@firm.test: The project creator already has owner access/,
            ),
        ).toBeInTheDocument();
        // The dialog stays open on the only screen that knows sharing failed.
        expect(onCreated).not.toHaveBeenCalled();

        // Retry: the project already exists, so it must not be created twice.
    await user.click(screen.getByRole("button", { name: "Criar projeto" }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(createProject).toHaveBeenCalledTimes(1);
        expect(grantProjectAccess).toHaveBeenCalledTimes(2);
    });

  it("persists a changed memory opt-out before retrying a created project", async () => {
    const user = userEvent.setup({ delay: null });
    const onCreated = renderModal();
    vi.mocked(grantProjectAccess).mockRejectedValueOnce(
      new MikeApiError({
        status: 400,
        message: "Sharing failed",
      }),
    );

    await fillAndAdd(user, "counsel@firm.test", "editor");
    await submit(user);
    await screen.findByText(/Projeto criado, mas o acesso não foi concedido/);

    await user.click(screen.getByRole("button", { name: "Voltar" }));
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    await user.click(
      screen.getByRole("switch", { name: "Ativar memória do projeto" }),
    );
    await user.click(screen.getByRole("button", { name: "Próximo" }));
    await user.click(screen.getByRole("button", { name: "Próximo" }));
    await user.click(screen.getByRole("button", { name: "Criar projeto" }));

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("p1", false),
    );
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ memory_enabled: false }),
    );
  });

  it("persists a changed memory opt-out before continuing after a partial upload", async () => {
    const user = userEvent.setup({ delay: null });
    const onCreated = renderModal();
    vi.mocked(uploadProjectDocuments).mockResolvedValue([
      {
        clientId: "one",
        filename: "saved.pdf",
        status: "completed",
        result: { id: "doc-1", filename: "saved.pdf" } as never,
        errorCode: null,
      },
      {
        clientId: "two",
        filename: "failed.pdf",
        status: "error",
        result: null,
        errorCode: "processing_failed",
      },
    ]);

    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "P");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["saved"], "saved.pdf"),
          new File(["failed"], "failed.pdf"),
        ],
      },
    });
    await submit(user);
    await screen.findByRole("button", { name: "Continuar" });

    await user.click(screen.getByRole("button", { name: "Voltar" }));
    await user.click(screen.getByRole("button", { name: "Voltar" }));
    await user.click(
      screen.getByRole("switch", { name: "Ativar memória do projeto" }),
    );
    await user.click(screen.getByRole("button", { name: "Próximo" }));
    await user.click(screen.getByRole("button", { name: "Próximo" }));
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("p1", false),
    );
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ memory_enabled: false }),
    );
  });

    it("shows direct sharing only on step two with Owner, Editor and Viewer", async () => {
        const user = userEvent.setup({ delay: null });
        renderModal();
    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "Matter");
        expect(
            screen.queryByPlaceholderText("Adicionar por e-mail…"),
        ).not.toBeInTheDocument();
        const next = screen.getByRole("button", { name: "Próximo" });
        await waitFor(() => expect(next).toBeEnabled());
        await user.click(next);
        const skip = screen.getByRole("button", { name: "Pular" });
        const accessNext = screen.getByRole("button", { name: "Próximo" });
        expect(skip.parentElement).toBe(accessNext.parentElement);
        expect(skip).toHaveClass("text-gray-500");
        expect(screen.getByRole("button", { name: "Voltar" })).toHaveClass(
            "bg-blue-600/90",
        );
        const trigger = await screen.findByRole("button", {
            name: /Papel do novo destinatário/,
        });
        expect(trigger).toHaveTextContent("Editor");
        await user.click(trigger);
        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent),
        ).toEqual(["Owner", "Editor", "Viewer"]);
    });

    it("adds organization Owners and denied members through typeahead fields", async () => {
        const user = userEvent.setup({ delay: null });
        vi.mocked(listOrgs).mockResolvedValue([
            { id: "org-1", name: "Elite Law LLP" } as never,
        ]);
        vi.mocked(listOrgMembers).mockResolvedValue([
            {
                user_id: "me",
                email: "me@firm.test",
                display_name: "Project Creator",
                role: "member",
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                user_id: "member-owner",
                email: "lead@elite.test",
                display_name: "Project Lead",
                role: "member",
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                user_id: "member-denied",
                email: "blocked@elite.test",
                display_name: "Blocked Member",
                role: "member",
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                user_id: "org-admin",
                email: "admin@elite.test",
                display_name: "Organization Admin",
                role: "admin",
                created_at: "2026-01-01T00:00:00Z",
            },
        ] as never);
        renderModal();
        await user.click(
            screen.getByLabelText("Compartilhar na organização"),
        );
        await user.click(
            await screen.findByRole("menuitem", { name: "Elite Law LLP" }),
        );
    await user.type(screen.getByPlaceholderText("Adicionar nome do projeto"), "Matter");
        await user.click(screen.getByRole("button", { name: "Próximo" }));
        expect(
            screen.getByRole("dialog", { name: "Acesso organizacional" }),
        ).toBeVisible();
        await screen.findByRole("searchbox", { name: "Donos do projeto" });
        expect(
            screen.getByText(
                "Adicione membros de Elite Law LLP como donos, com direitos para gerenciar o acesso e as configurações e excluir o projeto.",
            ),
        ).not.toHaveClass("pl-3");
        expect(screen.queryByText("Project Lead")).not.toBeInTheDocument();
        expect(screen.queryByText("Blocked Member")).not.toBeInTheDocument();

        const ownerPicker = screen.getByRole("searchbox", {
            name: "Donos do projeto",
        });
        const denyToggle = screen.getByRole("button", { name: "Lista de bloqueio" });
        expect(denyToggle).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByRole("searchbox", { name: "Lista de bloqueio" }),
        ).not.toBeInTheDocument();
        await user.click(denyToggle);
        const denyPicker = screen.getByRole("searchbox", {
            name: "Lista de bloqueio",
        });
        expect(
            screen.getByText(
                "Negue a membros de Elite Law LLP o acesso a este projeto.",
            ),
        ).not.toHaveClass("pl-3");
        await user.type(ownerPicker, "Organization Admin");
        expect(
            screen.queryByRole("option", { name: /Organization Admin/ }),
        ).not.toBeInTheDocument();
        await user.clear(ownerPicker);
        await user.type(denyPicker, "Organization Admin");
        expect(
            screen.queryByRole("option", { name: /Organization Admin/ }),
        ).not.toBeInTheDocument();
        await user.clear(denyPicker);

        await user.type(ownerPicker, "lead");
        await user.click(
            await screen.findByRole("option", { name: /Project Lead/ }),
        );
        await user.type(denyPicker, "blocked");
        await user.click(
            await screen.findByRole("option", { name: /Blocked Member/ }),
        );

        const ownerList = screen.getByRole("list", {
            name: "Lista de Donos do projeto",
        });
        const denyList = screen.getByRole("list", {
            name: "Lista de bloqueio",
        });
        expect(within(ownerList).getByText("Project Lead")).toBeInTheDocument();
    expect(within(ownerList).getByText("Project Creator")).toBeInTheDocument();
        expect(within(ownerList).getByText("lead@elite.test")).toHaveClass(
            "justify-self-end",
        );
        expect(
            within(ownerList).queryByRole("button", {
                name: "Remover me@firm.test",
            }),
        ).not.toBeInTheDocument();
    expect(within(denyList).getByText("Blocked Member")).toBeInTheDocument();
        expect(ownerList.parentElement).toHaveClass("h-28", "overflow-y-auto");
        expect(denyList.parentElement).toHaveClass("h-28", "overflow-y-auto");
        expect(
            ownerList.closest('[data-slot="organization-access-editor"]'),
        ).not.toHaveClass("overflow-y-auto");
        await submit(user);
        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "lead@elite.test",
                "owner",
            ),
        );
        expect(grantProjectAccess).toHaveBeenCalledWith(
            "p1",
            "blocked@elite.test",
            "deny",
        );
    });
});
