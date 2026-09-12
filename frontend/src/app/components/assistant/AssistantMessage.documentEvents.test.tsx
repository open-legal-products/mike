import {
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { withIntl } from "@/test/withIntl";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

describe("AssistantMessage document events", () => {
    it("opens every identified event document in the document panel", () => {
        const onOpenDocument = vi.fn();
        const events: AssistantEvent[] = [
            {
                type: "doc_read",
                filename: "read.docx",
                document_id: "document-read",
                version_id: "version-read",
                version_number: 2,
            },
            {
                type: "doc_find",
                filename: "searched.pdf",
                document_id: "document-find",
                version_id: "version-find",
                version_number: 5,
                query: "termination",
                total_matches: 2,
            },
            {
                type: "doc_created",
                filename: "created.docx",
                document_id: "document-created",
                version_id: "version-created",
                version_number: 3,
                download_url: "",
            },
            {
                type: "doc_replicated",
                filename: "template.docx",
                count: 2,
                copies: [
                    {
                        new_filename: "copy-one.docx",
                        document_id: "document-copy-one",
                        version_id: "version-copy-one",
                    },
                    {
                        new_filename: "copy-two.docx",
                        document_id: "document-copy-two",
                        version_id: "version-copy-two",
                    },
                ],
            },
            {
                type: "doc_edited",
                filename: "edited.docx",
                document_id: "document-edited",
                version_id: "version-edited",
                version_number: 4,
                download_url: "",
                annotations: [],
            },
        ];

        const { container } = render(
            withIntl(
                <AssistantMessage
                    events={events}
                    onOpenDocument={onOpenDocument}
                />,
            ),
        );

        expect(
            container.querySelector(
                'img[src*="/icons/file-types/word.svg"]',
            ),
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "read.docx" }));
        fireEvent.click(
            screen.getByRole("button", { name: "searched.pdf" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "created.docx" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "copy-one.docx" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "copy-two.docx" }),
        );
        fireEvent.click(
            screen.getByRole("button", { name: "edited.docx" }),
        );

        expect(onOpenDocument.mock.calls).toEqual([
            [
                {
                    documentId: "document-read",
                    filename: "read.docx",
                    versionId: "version-read",
                    versionNumber: 2,
                },
            ],
            [
                {
                    documentId: "document-find",
                    filename: "searched.pdf",
                    versionId: "version-find",
                    versionNumber: 5,
                },
            ],
            [
                {
                    documentId: "document-created",
                    filename: "created.docx",
                    versionId: "version-created",
                    versionNumber: 3,
                },
            ],
            [
                {
                    documentId: "document-copy-one",
                    filename: "copy-one.docx",
                    versionId: "version-copy-one",
                    versionNumber: 1,
                },
            ],
            [
                {
                    documentId: "document-copy-two",
                    filename: "copy-two.docx",
                    versionId: "version-copy-two",
                    versionNumber: 1,
                },
            ],
            [
                {
                    documentId: "document-edited",
                    filename: "edited.docx",
                    versionId: "version-edited",
                    versionNumber: 4,
                },
            ],
        ]);
    });

    it("opens the edit wrapper as a plain document but keeps individual edit context", () => {
        const onOpenDocument = vi.fn();
        const onEditViewClick = vi.fn();
        const events: AssistantEvent[] = [
            {
                type: "doc_edited",
                filename: "agreement.docx",
                document_id: "document-1",
                version_id: "version-2",
                version_number: 2,
                download_url: "",
                annotations: [
                    {
                        edit_id: "edit-1",
                        document_id: "document-1",
                        version_id: "version-2",
                        version_number: 2,
                        change_id: "change-1",
                        deleted_text: "old one",
                        inserted_text: "new one",
                        status: "pending",
                    },
                    {
                        edit_id: "edit-2",
                        document_id: "document-1",
                        version_id: "version-2",
                        version_number: 2,
                        change_id: "change-2",
                        deleted_text: "old two",
                        inserted_text: "new two",
                        status: "pending",
                    },
                ],
            },
        ];

        render(
            withIntl(
                <AssistantMessage
                    events={events}
                    onOpenDocument={onOpenDocument}
                    onEditViewClick={onEditViewClick}
                />,
            ),
        );

        // O 1º "Ver" no DOM é a ação em lote da seção (abre o documento);
        // os demais pertencem aos cards individuais.
        fireEvent.click(
            screen.getAllByRole("button", { name: "Ver" })[0],
        );
        expect(onOpenDocument).toHaveBeenCalledWith({
            documentId: "document-1",
            filename: "agreement.docx",
            versionId: "version-2",
            versionNumber: 2,
        });
        expect(onEditViewClick).not.toHaveBeenCalled();

        const cardGroups = screen.getAllByRole("group", {
            name: "Edit actions",
        });
        const cardViewButtons = cardGroups.map((group) =>
            within(group).getByRole("button", { name: "Ver" }),
        );
        fireEvent.click(cardViewButtons[0]);
        expect(onEditViewClick).toHaveBeenCalledWith(
            expect.objectContaining({ edit_id: "edit-1" }),
            "agreement.docx",
            1,
        );
    });
});
