import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { withIntl, type WithIntlMessages } from "@/test/withIntl";
import {
    mergeAccessContacts,
    PermissionDeniedPopup,
} from "./PermissionDeniedPopup";

// The popups.* namespaces land with this translation batch; the shared
// catalog still does not carry them, so the suite supplies exactly the
// strings the popup resolves.
const mensagens: WithIntlMessages = {
    popups: {
        aviso: { descartar: "Descartar aviso" },
        permissao: {
            tituloProprietario: "Ação exclusiva do proprietário",
            tituloEditores: "Exclusivo para editores",
            sujeitoProprietario: "o proprietário",
            sujeitoEditor: "um editor",
            somentePode: "Somente {sujeito} pode {acao}.",
            semAcao: "Somente {sujeito} pode executar esta ação.",
            pedirContato:
                "Fale com <tag>{nome}</tag> se precisar de acesso de {papel}.",
            papelProprietario: "proprietário",
            papelEditor: "editor",
        },
    },
};

describe("PermissionDeniedPopup", () => {
    it("speaks in the roles the product exposes", () => {
        render(
            withIntl(
                <PermissionDeniedPopup
                    open
                    action="excluir este projeto"
                    onClose={vi.fn()}
                />,
                mensagens,
            ),
        );
        expect(
            screen.getByText("Ação exclusiva do proprietário"),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Somente o proprietário pode excluir este projeto."),
        ).toBeInTheDocument();
    });

    it("uses the editor tier for actions a viewer cannot take", () => {
        render(
            withIntl(
                <PermissionDeniedPopup
                    open
                    action="enviar documentos"
                    requiredRole="editor"
                    onClose={vi.fn()}
                />,
                mensagens,
            ),
        );
        expect(screen.getByText("Exclusivo para editores")).toBeInTheDocument();
        expect(
            screen.getByText("Somente um editor pode enviar documentos."),
        ).toBeInTheDocument();
    });

    it("names the first contact who has an address", () => {
        // The bug this fixes: the popup used to guard its contact line on a
        // field the project endpoint never returned, so a refused user was
        // never told who to ask. The server now ranks admin contacts —
        // creator first — and the first one with an email is offered.
        render(
            withIntl(
                <PermissionDeniedPopup
                    open
                    action="alterar o compartilhamento"
                    contacts={[
                        {
                            email: null,
                            display_name: "Deleted Account",
                        },
                        {
                            email: "partner@firm.example",
                            display_name: "A Partner",
                        },
                        {
                            email: "second@firm.example",
                            display_name: null,
                        },
                    ]}
                    onClose={vi.fn()}
                />,
                mensagens,
            ),
        );
        expect(
            screen.getByText("A Partner (partner@firm.example)"),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(/second@firm.example/),
        ).not.toBeInTheDocument();
    });

    it("falls back to the bare address when there is no display name", () => {
        render(
            withIntl(
                <PermissionDeniedPopup
                    open
                    action="alterar o compartilhamento"
                    contacts={[{ email: "partner@firm.example" }]}
                    onClose={vi.fn()}
                />,
                mensagens,
            ),
        );
        expect(
            screen.getByText("partner@firm.example"),
        ).toBeInTheDocument();
    });

    it("omits the contact line when nobody can be named", () => {
        render(
            withIntl(
                <PermissionDeniedPopup
                    open
                    action="alterar o compartilhamento"
                    contacts={[{ email: null, display_name: null }]}
                    onClose={vi.fn()}
                />,
                mensagens,
            ),
        );
        expect(screen.queryByText(/se precisar/)).not.toBeInTheDocument();
    });

    it("states a rule no role can lift, without an ask-somebody line", () => {
        // Chat rename/delete are creator-only server-side, so the default
        // "Somente o proprietário pode …" copy would have named a tier that
        // cannot help — and there is nobody to ask, because nobody can
        // grant it.
        render(
            withIntl(
                <PermissionDeniedPopup
                    open
                    title="Apenas quem criou esta conversa"
                    message="Somente quem criou esta conversa pode renomeá-la."
                    onClose={vi.fn()}
                />,
                mensagens,
            ),
        );
        expect(
            screen.getByText("Apenas quem criou esta conversa"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                "Somente quem criou esta conversa pode renomeá-la.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(/Somente o proprietário/),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/se precisar/)).not.toBeInTheDocument();
    });

    it("renders nothing when closed", () => {
        const { container } = render(
            withIntl(
                <PermissionDeniedPopup open={false} onClose={vi.fn()} />,
                mensagens,
            ),
        );
        expect(container).toBeEmptyDOMElement();
    });
});

describe("mergeAccessContacts", () => {
    it("keeps server order, drops repeats and entries with no address", () => {
        // A bulk refusal spans several rows and the same admin usually
        // appears on all of them; the popup still has to name exactly one.
        expect(
            mergeAccessContacts([
                [
                    { email: null, display_name: "Deleted Account" },
                    { email: "Dana@firm.test", display_name: "Dana" },
                ],
                null,
                [
                    { email: "dana@firm.test", display_name: "Dana" },
                    { email: "sam@firm.test", display_name: "Sam" },
                ],
                undefined,
            ]),
        ).toEqual([
            { email: "Dana@firm.test", display_name: "Dana" },
            { email: "sam@firm.test", display_name: "Sam" },
        ]);
    });

    it("returns nothing when no row could name anyone", () => {
        expect(mergeAccessContacts([null, undefined, []])).toEqual([]);
    });
});
