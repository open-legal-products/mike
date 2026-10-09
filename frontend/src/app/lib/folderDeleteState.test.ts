import { describe, expect, it } from "vitest";
import type { Folder } from "../components/shared/types";
import {
    INITIAL_FOLDER_DELETE_DIALOG_STATE,
    clearDeletedDocumentId,
    folderDeleteDialogReducer,
    removeDeletedDocumentTabs,
    type PendingDeleteFolder,
} from "./folderDeleteState";

function pendingFolder(id: string): PendingDeleteFolder {
    const folder: Folder = {
        id,
        project_id: "project-1",
        user_id: "user-1",
        name: `Folder ${id}`,
        parent_folder_id: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
    };

    return {
        folder,
        folderIds: [id],
        documentIds: [`document-${id}`],
        documentCount: 1,
    };
}

describe("folderDeleteDialogReducer", () => {
    it("dismisses the completed confirmation for the matching folder", () => {
        const pending = pendingFolder("folder-1");
        const requested = folderDeleteDialogReducer(
            INITIAL_FOLDER_DELETE_DIALOG_STATE,
            { type: "request", pending },
        );
        const deleting = folderDeleteDialogReducer(requested, {
            type: "start",
            folderId: pending.folder.id,
        });
        const deleted = folderDeleteDialogReducer(deleting, {
            type: "complete",
            folderId: pending.folder.id,
        });

        expect(
            folderDeleteDialogReducer(deleted, {
                type: "dismiss-completed",
                folderId: pending.folder.id,
            }),
        ).toEqual(INITIAL_FOLDER_DELETE_DIALOG_STATE);
    });

    it("does not let an old completion timer dismiss a newer confirmation", () => {
        const first = pendingFolder("folder-1");
        const second = pendingFolder("folder-2");
        const firstCompleted = {
            pending: first,
            status: "deleted" as const,
        };
        const secondRequested = folderDeleteDialogReducer(firstCompleted, {
            type: "request",
            pending: second,
        });

        expect(
            folderDeleteDialogReducer(secondRequested, {
                type: "dismiss-completed",
                folderId: first.folder.id,
            }),
        ).toBe(secondRequested);
    });

    it("returns to idle when a delete fails, keeping the dialog open for retry", () => {
        const pending = pendingFolder("folder-1");
        const deleting = {
            pending,
            status: "deleting" as const,
        };

        const failed = folderDeleteDialogReducer(deleting, {
            type: "failed",
            folderId: pending.folder.id,
        });

        expect(failed).toEqual({ pending, status: "idle" });
    });

    it("ignores start and failed actions targeting a folder that is no longer pending", () => {
        const current = {
            pending: pendingFolder("folder-2"),
            status: "idle" as const,
        };

        expect(
            folderDeleteDialogReducer(current, {
                type: "start",
                folderId: "folder-1",
            }),
        ).toBe(current);
        expect(
            folderDeleteDialogReducer(current, {
                type: "failed",
                folderId: "folder-1",
            }),
        ).toBe(current);
    });

    it("cancel closes an idle dialog but not one mid-delete", () => {
        const pending = pendingFolder("folder-1");

        expect(
            folderDeleteDialogReducer(
                { pending, status: "idle" },
                { type: "cancel" },
            ),
        ).toEqual(INITIAL_FOLDER_DELETE_DIALOG_STATE);

        // Mid-delete the request is already in flight; closing the dialog
        // here would hide the outcome from the user.
        const deleting = { pending, status: "deleting" as const };
        expect(
            folderDeleteDialogReducer(deleting, { type: "cancel" }),
        ).toBe(deleting);
    });

    it("ignores a stale async completion after another folder is requested", () => {
        const first = pendingFolder("folder-1");
        const second = pendingFolder("folder-2");
        const secondRequested = folderDeleteDialogReducer(
            {
                pending: first,
                status: "deleting",
            },
            { type: "request", pending: second },
        );

        expect(
            folderDeleteDialogReducer(secondRequested, {
                type: "complete",
                folderId: first.folder.id,
            }),
        ).toBe(secondRequested);
    });
});

describe("deleted document reconciliation", () => {
    const deletedDocumentIds = new Set(["document-2"]);

    it("removes only tabs belonging to deleted documents", () => {
        const tabs = [
            { documentId: "document-1", filename: "one.pdf" },
            { documentId: "document-2", filename: "two.pdf" },
        ];

        expect(removeDeletedDocumentTabs(tabs, deletedDocumentIds)).toEqual([
            tabs[0],
        ]);
    });

    it("clears the latest active or selected deleted document ID", () => {
        expect(clearDeletedDocumentId("document-2", deletedDocumentIds)).toBe(
            null,
        );
        expect(clearDeletedDocumentId("document-1", deletedDocumentIds)).toBe(
            "document-1",
        );
        expect(clearDeletedDocumentId(null, deletedDocumentIds)).toBeNull();
    });


});
