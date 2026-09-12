import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { withIntl } from "@/test/withIntl";

// The popups.aviso namespace lands with this translation batch; the shared
// catalog still does not carry it.
const mensagensPopup = {
    popups: {
        aviso: { descartar: "Descartar aviso" },
    },
};
import { MikeApiError } from "@/app/lib/mikeApi";
import { OrganizationWorkspace } from "./OrganizationWorkspace";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  role: "admin" as "admin" | "member",
  getOrg: vi.fn(),
  listOrgMembers: vi.fn(),
  listOrgResources: vi.fn(),
  listOrgInvitations: vi.fn(),
  updateOrgMember: vi.fn(),
  removeOrgMember: vi.fn(),
  updateOrg: vi.fn(),
  deleteOrg: vi.fn(),
  createOrgInvitation: vi.fn(),
  cancelOrgInvitation: vi.fn(),
  resendOrgInvitation: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "me", email: "me@firm.example" } }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrg: mocks.getOrg,
  listOrgMembers: mocks.listOrgMembers,
  listOrgResources: mocks.listOrgResources,
  listOrgInvitations: mocks.listOrgInvitations,
  updateOrgMember: mocks.updateOrgMember,
  removeOrgMember: mocks.removeOrgMember,
  updateOrg: mocks.updateOrg,
  deleteOrg: mocks.deleteOrg,
  createOrgInvitation: mocks.createOrgInvitation,
  cancelOrgInvitation: mocks.cancelOrgInvitation,
  resendOrgInvitation: mocks.resendOrgInvitation,
}));

beforeEach(() => {
  vi.clearAllMocks();
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
  mocks.role = "admin";
  mocks.getOrg.mockImplementation(async () => ({
    id: "org-1",
    name: "Elite Law LLP",
    created_by: "me",
    role: mocks.role,
  }));
  mocks.listOrgMembers.mockResolvedValue([
    {
      id: "m1",
      user_id: "me",
      display_name: "William Chen",
      email: "me@firm.example",
      role: "admin",
      created_at: "2026-08-30T00:00:00Z",
    },
    {
      id: "m2",
      user_id: "u2",
      display_name: "Jane Lee",
      email: "jane@firm.example",
      role: "member",
      created_at: "2026-09-01T00:00:00Z",
    },
  ]);
  mocks.listOrgResources.mockResolvedValue({
    projects: [
      {
        id: "project-1",
        user_id: "me",
        org_id: "org-1",
        name: "Apollo",
        practice: "Corporate",
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
    workflows: [
      {
        id: "workflow-1",
        user_id: "u2",
        org_id: "org-1",
        title: "Disclosure workflow",
        type: "tabular",
        practice: "Corporate",
        created_at: "2026-09-01T00:00:00Z",
      },
    ],
  });
  mocks.listOrgInvitations.mockResolvedValue([]);
});

describe("OrganizationWorkspace", () => {
  it("shows the breadcrumb, member identity columns, and every resource tab", async () => {
    const user = userEvent.setup();
    render(withIntl(<OrganizationWorkspace orgId="org-1" />, mensagensPopup));

    expect(await screen.findByText("William Chen")).toBeInTheDocument();
    expect(screen.getByText("me@firm.example")).toBeInTheDocument();
    expect(screen.getAllByText("Elite Law LLP")).not.toHaveLength(0);
    expect(screen.getByText("Adicionado em")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Selecionar todas as pessoas" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Filtrar por papel" }),
    ).toBeInTheDocument();
    const peopleRow = screen
      .getByRole("checkbox", { name: "Selecionar Jane Lee" })
      .closest(".group");
    expect(peopleRow).toHaveClass("liquid-glass-hover");
    expect(peopleRow).not.toHaveClass("cursor-pointer");

    await user.click(screen.getByRole("button", { name: "Projetos" }));
    expect(screen.getByRole("link", { name: "Abrir Apollo" })).toHaveClass(
      "liquid-glass-hover",
    );
    await user.click(screen.getByRole("button", { name: "Workflows" }));
    expect(
      screen.getByRole("link", { name: "Abrir Disclosure workflow" }),
    ).toHaveClass("liquid-glass-hover");
    expect(screen.queryByRole("button", { name: "Chats" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reviews" })).not.toBeInTheDocument();
  });

  it("lets admins change a member's role from the colored role tab", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockResolvedValue({});
    render(withIntl(<OrganizationWorkspace orgId="org-1" />, mensagensPopup));
    await screen.findByText("Jane Lee");

    const roleTab = screen.getByRole("button", {
      name: "Alterar papel de Jane Lee",
    });
    expect(roleTab).toHaveClass("bg-violet-100", "text-violet-700");
    await user.click(roleTab);
    await user.click(screen.getByRole("menuitem", { name: "Administrador" }));

    await waitFor(() =>
      expect(mocks.updateOrgMember).toHaveBeenCalledWith(
        "org-1",
        "u2",
        "admin",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Alterar papel de Jane Lee" }),
    ).toHaveClass("bg-blue-100", "text-blue-700");
  });

  it("shows last-admin failures with the warning primitive", async () => {
    const user = userEvent.setup();
    mocks.updateOrgMember.mockRejectedValue(
      new MikeApiError({
        status: 409,
        message: "A organização precisa manter pelo menos um administrador.",
      }),
    );
    render(withIntl(<OrganizationWorkspace orgId="org-1" />, mensagensPopup));
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("button", { name: "Alterar papel de William Chen" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Membro" }));

    expect(
      await screen.findByText("A organização precisa manter pelo menos um administrador."),
    ).toBeInTheDocument();
    expect(screen.getByText("Falha na ação da organização")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Descartar aviso" }),
    ).toBeInTheDocument();
  });

  it("reveals a toolbar action and removes selected people", async () => {
    const user = userEvent.setup();
    mocks.removeOrgMember.mockResolvedValue(undefined);
    render(withIntl(<OrganizationWorkspace orgId="org-1" />, mensagensPopup));
    await screen.findByText("Jane Lee");

    expect(
      screen.queryByRole("button", { name: "Ações" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Selecionar Jane Lee" }));
    await user.click(screen.getByRole("button", { name: "Ações" }));
    const removeAction = screen.getByRole("menuitem", {
      name: "Remover todos os selecionados",
    });
    expect(removeAction.querySelector("svg")).toHaveClass("text-red-600");
    await user.click(removeAction);

    expect(screen.getByText("Remover as pessoas selecionadas?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remover" }));
    await waitFor(() =>
      expect(mocks.removeOrgMember).toHaveBeenCalledWith("org-1", "u2"),
    );
    expect(screen.queryByText("Jane Lee")).not.toBeInTheDocument();
  });

  it("warns an admin who includes themselves in bulk removal", async () => {
    const user = userEvent.setup();
    render(withIntl(<OrganizationWorkspace orgId="org-1" />, mensagensPopup));
    await screen.findByText("William Chen");

    await user.click(
      screen.getByRole("checkbox", { name: "Selecionar William Chen" }),
    );
    await user.click(screen.getByRole("button", { name: "Ações" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remover todos os selecionados" }),
    );

    expect(
      await screen.findByText("A organização precisa manter pelo menos um administrador."),
    ).toBeInTheDocument();
    expect(mocks.removeOrgMember).not.toHaveBeenCalled();
  });

  it("offers add-member and settings actions only to admins", async () => {
    const user = userEvent.setup();
    render(withIntl(<OrganizationWorkspace orgId="org-1" />, mensagensPopup));
    await screen.findByText("William Chen");

    await user.click(screen.getByRole("button", { name: "Adicionar membro" }));
    expect(screen.getByText("Endereço de e-mail")).toBeInTheDocument();
    expect(mocks.listOrgInvitations).toHaveBeenCalledWith("org-1");

    await user.keyboard("{Escape}");
    await user.click(
      screen.getByRole("button", { name: "Configurações da organização" }),
    );
    await user.click(screen.getByText("Configurações da organização"));
    expect(screen.getByLabelText("Nome da organização")).toHaveValue(
      "Elite Law LLP",
    );
  });

  it("lets members browse resources but does not load administrative invitations", async () => {
    mocks.role = "member";
    const user = userEvent.setup();
    render(withIntl(<OrganizationWorkspace orgId="org-1" />, mensagensPopup));
    await screen.findByText("William Chen");

    expect(mocks.listOrgInvitations).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "Somente administradores da organização podem adicionar membros",
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Configurações da organização" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Workflows" }));
    expect(screen.getByText("Disclosure workflow")).toBeInTheDocument();
  });
});
