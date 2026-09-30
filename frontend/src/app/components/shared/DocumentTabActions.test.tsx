import { useEffect, useState } from "react";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectDocumentTabs } from "../projects/ProjectDocumentTabs";
import { AssistantSidePanel } from "../assistant/AssistantSidePanel";
import type { Document } from "./types";

vi.mock("@/app/hooks/useDocumentPermissions", () => ({ useDocumentPermissions: (_ids: string[], enabled: boolean) => () => ({ canEdit: enabled, canDelete: enabled }) }));

const localDownload = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../assistant/DocPanel", () => ({
    DocPanel: ({
        onDownloadReady,
    }: {
        onDownloadReady?: (download: () => Promise<void>) => void;
    }) => {
        useEffect(() => {
            onDownloadReady?.(localDownload);
        }, [onDownloadReady]);
        return <div>Document body</div>;
    },
}));

function Harness({
    surface,
    rename,
    action,
    disabled = false,
}: {
    surface: "project" | "assistant";
    rename: (id: string, filename: string) => Promise<void>;
    action: (action: string, id: string) => void;
    disabled?: boolean;
}) {
    const [files, setFiles] = useState([
        { id: "first", filename: "First.docx" },
        { id: "second", filename: "Second.docx" },
    ]);
    const onRename = async (id: string, filename: string) => {
        await rename(id, filename);
        setFiles((current) =>
            current.map((file) =>
                file.id === id ? { ...file, filename } : file,
            ),
        );
    };
    return surface === "project" ? (
        <ProjectDocumentTabs
            documentPermissions={() => ({ canEdit: true, canDelete: true })}
            tabs={files.map((file) => ({
                documentId: file.id,
                filename: file.filename,
            }))}
            documents={files as Document[]}
            activeTabId="first"
            onActivate={(id) => action("open", id)}
            onClose={vi.fn()}
            onReorder={vi.fn()}
            onRenameDoc={onRename}
            onDeleteDoc={async (id) => action("delete", id)}
            onAddToChat={(file) => action("add", file.id)}
            onDownloadDoc={async (file) => action("download", file.id)}
            addToChatDisabled={disabled}
            downloading={disabled}
        />
    ) : (
        <AssistantSidePanel
            canEdit
            tabs={files.map((file) => ({
                kind: "document",
                id: file.id,
                document: {
                    document_id: file.id,
                    title: file.filename,
                    type: "docx",
                    quotes: [],
                    metadata: [],
                },
            }))}
            activeTabId="first"
            onActivateTab={(id) => action("open", id)}
            onCloseTab={vi.fn()}
            onCloseAll={vi.fn()}
            documentActions={(document) => ({
                onRename: (filename) =>
                    onRename(document.document_id, filename),
                onAddToChat: () => action("add", document.document_id),
                onDownload: () => action("download", document.document_id),
                onDelete: () => action("delete", document.document_id),
                addToChatDisabled: disabled,
                downloading: disabled,
            })}
        />
    );
}

function menuFor(name = "Second.docx") {
    fireEvent.contextMenu(screen.getByRole("tab", { name }), {
        clientX: 200,
        clientY: 100,
    });
    return screen.getByRole("menu");
}

describe.each(["project", "assistant"] as const)(
    "%s document tabs",
    (surface) => {
        it("omits Open and targets the right-clicked inactive tab", async () => {
            const action = vi.fn();
            render(
                <Harness surface={surface} rename={vi.fn()} action={action} />,
            );
            const menu = menuFor();
            expect(
                within(menu)
                    .getAllByRole("menuitem")
                    .map((item) => item.textContent),
            ).toEqual([
                "Add to chat",
                "Download",
                "Rename",
                "Delete file",
            ]);
            expect(action).not.toHaveBeenCalled();
            fireEvent.click(within(menu).getByText("Add to chat"));
            expect(action).toHaveBeenCalledWith("add", "second");
            fireEvent.click(within(menuFor()).getByText("Delete file"));
            expect(action).toHaveBeenCalledWith("delete", "second");
        });

        it("renames inside the tab once, preserves focus and commits on Enter", async () => {
            const rename = vi.fn().mockResolvedValue(undefined);
            render(
                <Harness surface={surface} rename={rename} action={vi.fn()} />,
            );
            fireEvent.click(within(menuFor()).getByText("Rename"));
            const input = await screen.findByRole("textbox", {
                name: "File name",
            });
            expect(
                screen.getByRole("tab", { name: "Second.docx" }),
            ).toContainElement(input);
            await waitFor(() => expect(input).toHaveFocus());
            expect((input as HTMLInputElement).selectionEnd).toBe(
                "Second".length,
            );
            fireEvent.change(input, { target: { value: "Renamed.docx" } });
            fireEvent.keyDown(input, { key: "Enter" });
            fireEvent.blur(input);
            await waitFor(() =>
                expect(
                    screen.getByRole("tab", { name: "Renamed.docx" }),
                ).toBeVisible(),
            );
            expect(rename).toHaveBeenCalledExactlyOnceWith(
                "second",
                "Renamed.docx",
            );
            expect(screen.queryByRole("textbox")).toBeNull();
        });

        it.each([{ isComposing: true }, { keyCode: 229 }])("does not rename while confirming an IME candidate (%j)", async (composition) => {
            const rename = vi.fn().mockResolvedValue(undefined);
            render(<Harness surface={surface} rename={rename} action={vi.fn()} />);
            fireEvent.click(within(menuFor()).getByText("Rename"));
            const input = await screen.findByRole("textbox");
            fireEvent.change(input, { target: { value: "合同.docx" } });
            fireEvent.keyDown(input, { key: "Enter", ...composition });
            expect(rename).not.toHaveBeenCalled();
            expect(input).toHaveFocus();
            fireEvent.keyDown(input, { key: "Enter" });
            await waitFor(() => expect(rename).toHaveBeenCalledExactlyOnceWith("second", "合同.docx"));
        });

        it("cancels on Escape and commits a changed name on blur", async () => {
            const rename = vi.fn().mockResolvedValue(undefined);
            render(
                <Harness surface={surface} rename={rename} action={vi.fn()} />,
            );
            const tab = screen.getByRole("tab", { name: "Second.docx" });
            fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
            fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
            let input = await screen.findByRole("textbox");
            fireEvent.change(input, { target: { value: "Cancelled.docx" } });
            fireEvent.keyDown(input, { key: "Escape" });
            expect(rename).not.toHaveBeenCalled();
            expect(screen.queryByRole("textbox")).toBeNull();
            fireEvent.click(within(menuFor()).getByText("Rename"));
            input = await screen.findByRole("textbox");
            fireEvent.change(input, { target: { value: "Blur.docx" } });
            fireEvent.blur(input);
            await waitFor(() =>
                expect(rename).toHaveBeenCalledExactlyOnceWith(
                    "second",
                    "Blur.docx",
                ),
            );
        });

        it("retains the input after a failed rename without exposing server details", async () => {
            const rename = vi
                .fn()
                .mockRejectedValue(new Error("private database details"));
            render(
                <Harness surface={surface} rename={rename} action={vi.fn()} />,
            );
            fireEvent.click(within(menuFor()).getByText("Rename"));
            const input = await screen.findByRole("textbox");
            fireEvent.change(input, { target: { value: "Retry.docx" } });
            fireEvent.keyDown(input, { key: "Enter" });
            expect(
                await screen.findByText(
                    "This file could not be renamed. Please try again.",
                ),
            ).toBeVisible();
            expect(input).toHaveValue("Retry.docx");
            expect(screen.queryByText("private database details")).toBeNull();
            expect(rename).toHaveBeenCalledOnce();
        });

        it("preserves disabled Add to chat and Download actions", () => {
            render(
                <Harness
                    surface={surface}
                    rename={vi.fn()}
                    action={vi.fn()}
                    disabled
                />,
            );
            const menu = menuFor();
            expect(
                within(menu).getByRole("menuitem", { name: "Add to chat" }),
            ).toHaveAttribute("aria-disabled", "true");
            expect(
                within(menu).getByRole("menuitem", { name: "Download" }),
            ).toHaveAttribute("aria-disabled", "true");
        });
    },
);

it("downloads the assistant tab's open editor rather than fetching an older file", () => {
    const action = vi.fn();
    localDownload.mockClear();
    render(<Harness surface="assistant" rename={vi.fn()} action={action} />);
    fireEvent.click(within(menuFor()).getByText("Download"));
    expect(localDownload).toHaveBeenCalledOnce();
    expect(action).not.toHaveBeenCalled();
});
