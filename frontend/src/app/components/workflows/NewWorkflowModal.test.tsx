import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    copyDocumentsToWorkflowAssets,
    createWorkflow,
    listOrgMembers,
    listOrgs,
    shareWorkflow,
    updateWorkflow,
} from "@/app/lib/mikeApi";
import type { Document, Workflow } from "../shared/types";
import { NewWorkflowModal } from "./NewWorkflowModal";
import { withIntl } from "@/test/withIntl";

const { useUserProfile } = vi.hoisted(() => ({
    useUserProfile: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    copyDocumentsToWorkflowAssets: vi.fn(),
    createWorkflow: vi.fn(),
    listOrgMembers: vi.fn(),
    listOrgs: vi.fn(),
    shareWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
}));

vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: ({
        onChange,
    }: {
        onChange: (documents: Document[]) => void;
    }) => (
        <button
            type="button"
            onClick={() =>
                onChange([
                    {
                        id: "document-1",
                        filename: "Precedent.pdf",
                    } as Document,
                ])
            }
        >
            Select asset
        </button>
    ),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile,
}));

const workflow = {
    id: "workflow-1",
    is_owner: true,
    metadata: {
        title: "Contract Intake",
        type: "assistant",
        language: "English",
        practice: "Litigation",
        jurisdictions: ["Singapore"],
    },
} as Workflow;

describe("NewWorkflowModal editing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listOrgs).mockResolvedValue([]);
        vi.mocked(listOrgMembers).mockResolvedValue([]);
        vi.mocked(createWorkflow).mockResolvedValue(workflow);
        vi.mocked(copyDocumentsToWorkflowAssets).mockResolvedValue([]);
        vi.mocked(shareWorkflow).mockResolvedValue(undefined);
        vi.mocked(updateWorkflow).mockResolvedValue(workflow);
        useUserProfile.mockReturnValue({ profile: { practiceAreas: [] } });
    });

    it("pairs Type with Jurisdiction and presets Practice area from the profile", async () => {
        useUserProfile.mockReturnValue({
            profile: { practiceAreas: ["Litigation"] },
        });
        render(
            withIntl(
                <NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />,
            ),
        );

        const typeField = screen.getByText("Tipo").parentElement;
        const jurisdictionField =
            screen.getByText("Jurisdição").parentElement;
        expect(typeField?.parentElement).toBe(jurisdictionField?.parentElement);
        expect(typeField?.parentElement).toHaveClass("grid", "md:grid-cols-2");
        expect(await screen.findByLabelText("Área de Prática")).toHaveTextContent(
            "Litigation",
        );
    });

    it("disables Save until details change", () => {
        render(
            withIntl(
                <NewWorkflowModal
                    open
                    editWorkflow={workflow}
                    onClose={vi.fn()}
                    onCreated={vi.fn()}
                    onUpdated={vi.fn()}
                />,
            ),
        );

        const save = screen.getByRole("button", { name: "Salvar" });
        expect(save).toBeDisabled();

        const title = screen.getByLabelText("Título");
        fireEvent.change(title, { target: { value: "Contract Review" } });
        expect(save).toBeEnabled();

        fireEvent.change(title, { target: { value: "Contract Intake" } });
        expect(save).toBeDisabled();
    });

    it("shows the current organisation in workflow details", async () => {
        vi.mocked(listOrgs).mockResolvedValue([
            { id: "org-1", name: "Elite Law LLP" } as never,
        ]);

        render(
            withIntl(
                <NewWorkflowModal
                    open
                    editWorkflow={{ ...workflow, org_id: "org-1" }}
                    onClose={vi.fn()}
                    onCreated={vi.fn()}
                    onUpdated={vi.fn()}
                />,
            ),
        );

        const organisation = await screen.findByLabelText("Organização");
        expect(organisation).toBeDisabled();
        expect(organisation).toHaveTextContent("Elite Law LLP");
    });

    it("creates an assistant workflow only after the Assets screen", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            withIntl(
                <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
            ),
        );

        await user.type(screen.getByLabelText("Título"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Próximo" }));

        expect(screen.getByRole("dialog", { name: "Acesso" })).toBeVisible();
        expect(screen.getByText("Compartilhar acesso")).toBeInTheDocument();
        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const skip = screen.getByRole("button", { name: "Pular" });
        const next = screen.getByRole("button", { name: "Próximo" });
        expect(skip.parentElement).toBe(next.parentElement);
        expect(skip).toHaveClass("text-gray-500");
        expect(screen.getByRole("button", { name: "Voltar" })).toHaveClass(
            "bg-blue-600/90",
        );

        await user.click(next);
        expect(
            screen.getByRole("dialog", { name: "Adicionar Arquivos" }),
        ).toBeVisible();
        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Criar fluxo" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(onCreated).toHaveBeenCalledWith({
            ...workflow,
            access_scope: "private",
            organization_name: null,
        });
    });

    it("moves a skipped assistant Access screen to Assets before creating", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            withIntl(
                <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
            ),
        );

        await user.type(screen.getByLabelText("Título"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Próximo" }));
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Pular" }));
        expect(
            screen.getByRole("dialog", { name: "Adicionar Arquivos" }),
        ).toBeVisible();
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Criar fluxo" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(shareWorkflow).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalledWith({
            ...workflow,
            access_scope: "private",
            organization_name: null,
        });
    });

    it("copies selected directory files before completing assistant creation", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            withIntl(
                <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
            ),
        );

        await user.type(screen.getByLabelText("Título"), "New workflow");
        await user.click(screen.getByRole("button", { name: "Próximo" }));
        await user.click(screen.getByRole("button", { name: "Próximo" }));
        await user.click(screen.getByRole("button", { name: "Select asset" }));
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Criar fluxo" }),
        );

        await waitFor(() =>
            expect(copyDocumentsToWorkflowAssets).toHaveBeenCalledWith(
                "workflow-1",
                ["document-1"],
            ),
        );
        expect(onCreated).toHaveBeenCalled();
        expect(
            vi.mocked(copyDocumentsToWorkflowAssets).mock
                .invocationCallOrder[0],
        ).toBeLessThan(onCreated.mock.invocationCallOrder[0]);
    });

    it("finishes a tabular workflow on Access without showing Assets", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            withIntl(
                <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
            ),
        );

        await user.click(screen.getByRole("button", { name: "Tabular" }));
        await user.type(screen.getByLabelText("Título"), "Tabular workflow");
        await user.click(screen.getByRole("button", { name: "Próximo" }));

        expect(screen.getByRole("dialog", { name: "Acesso" })).toBeVisible();
        expect(
            screen.getByRole("button", { name: "Criar fluxo" }),
        ).toBeVisible();
        expect(screen.queryByText("Select asset")).not.toBeInTheDocument();
        expect(createWorkflow).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Criar fluxo" }),
        );
        await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
        expect(copyDocumentsToWorkflowAssets).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalled();
    });

    it("never creates a new workflow from a generic form submission", () => {
        const onCreated = vi.fn();
        render(
            withIntl(
                <NewWorkflowModal open onClose={vi.fn()} onCreated={onCreated} />,
            ),
        );

        fireEvent.change(screen.getByLabelText("Título"), {
            target: { value: "New workflow" },
        });
        const form = document.getElementById("workflow-modal-form");
        expect(form).not.toBeNull();

        fireEvent.submit(form!);
        expect(screen.getByRole("dialog", { name: "Acesso" })).toBeVisible();
        fireEvent.submit(form!);

        expect(createWorkflow).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();
    });

    it("puts organization sharing last and names its access screen", async () => {
        const user = userEvent.setup({ delay: null });
        vi.mocked(listOrgs).mockResolvedValue([
            { id: "org-1", name: "Elite Law LLP" } as never,
        ]);
        render(
            withIntl(
                <NewWorkflowModal open onClose={vi.fn()} onCreated={vi.fn()} />,
            ),
        );

        const jurisdiction = screen.getByLabelText("Jurisdição");
        const organization = await screen.findByLabelText(
            "Compartilhar com a Organização",
        );
        expect(
            jurisdiction.compareDocumentPosition(organization) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        await user.click(organization);
        await user.click(
            await screen.findByRole("menuitem", { name: "Elite Law LLP" }),
        );
        await user.type(screen.getByLabelText("Título"), "Firm workflow");
        await user.click(screen.getByRole("button", { name: "Próximo" }));

        expect(
            screen.getByRole("dialog", { name: "Acesso Organizacional" }),
        ).toBeVisible();
        expect(
            screen.getByText(
                "Adicione membros de Elite Law LLP como donos, com direitos para gerenciar o acesso e as configurações e excluir o workflow.",
            ),
        ).not.toHaveClass("pl-3");
        const denyToggle = screen.getByRole("button", { name: "Lista de bloqueio" });
        expect(denyToggle).toHaveAttribute("aria-expanded", "false");
        expect(
            screen.queryByRole("searchbox", { name: "Lista de bloqueio" }),
        ).not.toBeInTheDocument();
        await user.click(denyToggle);
        expect(
            screen.getByText(
                "Negue a membros de Elite Law LLP o acesso a este workflow.",
            ),
        ).not.toHaveClass("pl-3");
    });
});
