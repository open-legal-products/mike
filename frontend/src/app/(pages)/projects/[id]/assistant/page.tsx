"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { deleteChat, renameChat } from "@/app/lib/mikeApi";
import { deleteTabularReviewsWithConcurrency } from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { ProjectAssistantTable } from "@/app/components/projects/ProjectAssistantTable";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import type { Chat } from "@/app/components/shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { can, roleFrom } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectAssistantPage({ params }: Props) {
    use(params);
    const workspace = useProjectWorkspace();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { user } = useAuth();
    const previewEmptyStates = searchParams.get("emptyStates") === "1";
    const {
        ensureProjectChats,
        projectChats,
        projectId,
        search,
        setProjectChats,
        setOwnerOnlyAction,
    } = workspace;
    const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
    const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
    const [renameChatValue, setRenameChatValue] = useState("");
    const [confirmDeleteSelectedOpen, setConfirmDeleteSelectedOpen] =
        useState(false);
    // One place for "the server refused, or the request failed" — the
    // silent `.catch(() => {})` this replaces is why a 403 used to look
    // exactly like a success until the page was reloaded.
    const [actionNotice, setActionNotice] = useState<{
        title: string;
        message: string;
    } | null>(null);
    const chats = useMemo(() => projectChats ?? [], [projectChats]);
    const visibleChats = previewEmptyStates ? [] : chats;
    const loading = projectChats === null && !previewEmptyStates;

    useEffect(() => {
        void ensureProjectChats();
    }, [ensureProjectChats]);

    const q = search.toLowerCase();
    const filteredChats = q
        ? visibleChats.filter((c) => (c.title ?? "").toLowerCase().includes(q))
        : visibleChats;

    async function submitChatRename(chatId: string) {
        const trimmed = renameChatValue.trim();
        setRenamingChatId(null);
        if (!trimmed) return;
        try {
            await renameChat(chatId, trimmed);
        } catch (error) {
            setActionNotice({
                title: "The chat was not renamed",
                message: userFacingApiError(
                    error,
                    "The chat could not be renamed. Please try again.",
                ),
            });
            return;
        }
        setProjectChats((prev) =>
            (prev ?? []).map((chat) =>
                chat.id === chatId ? { ...chat, title: trimmed } : chat,
            ),
        );
    }

    // Deleting a chat is `container.delete` (admin) on the SERVED role, not
    // "am I the row's creator". The old creator test was wrong in both
    // directions under the project role ladder: a project admin may delete a
    // colleague's chat, and being on a chat's share list makes you a member,
    // who may not delete anything.
    async function handleDeleteChatRow(chat: Chat) {
        if (!can(roleFrom(chat), "container.delete")) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        // Await first, remove after: a refusal or an outage used to make the
        // row disappear locally and come back on reload with no explanation.
        // The row action calls this without awaiting, so rethrowing would
        // only produce an unhandled rejection.
        try {
            await deleteChat(chat.id);
        } catch (error) {
            setActionNotice({
                title: "The chat was not deleted",
                message: userFacingApiError(
                    error,
                    "The chat could not be deleted. Please try again.",
                ),
            });
            return;
        }
        setProjectChats((prev) => (prev ?? []).filter((c) => c.id !== chat.id));
    }

    /**
     * Both bulk entry points — the toolbar's Actions menu and the row menu's
     * "Delete N chats" — ask first. A multi-row delete is the least reversible
     * thing on this page, and one of the rows may belong to a colleague.
     */
    function requestDeleteSelectedChats() {
        if (selectedChatIds.length === 0) return;
        setConfirmDeleteSelectedOpen(true);
    }

    const handleDeleteSelectedChats = useCallback(async () => {
        const ids = [...selectedChatIds];
        setConfirmDeleteSelectedOpen(false);
        setActionNotice(null);
        const roleById = new Map(
            chats.map((chat) => [chat.id, roleFrom(chat)] as const),
        );
        const deletable = ids.filter((id) => {
            const role = roleById.get(id);
            // A row we no longer hold is left to the server to judge; it
            // answers 403 or 404, and the failure is reported below rather
            // than swallowed.
            return role ? can(role, "container.delete") : true;
        });
        const blocked = ids.length - deletable.length;
        setSelectedChatIds([]);
        // Bounded concurrency with per-id outcomes, the same helper the
        // review and workflow tables use: `Promise.all(... .catch(() => {}))`
        // discarded every failure, so a 403 looked exactly like a success and
        // the chat reappeared on the next load.
        const { deletedIds, failedIds } =
            await deleteTabularReviewsWithConcurrency(deletable, deleteChat);
        setProjectChats((prev) =>
            (prev ?? []).filter((chat) => !deletedIds.includes(chat.id)),
        );
        // Anything that failed stays selected, so "try again" is one click.
        setSelectedChatIds(failedIds);
        const notices = [
            blocked > 0
                ? `${blocked} selected chat${blocked === 1 ? " was" : "s were"} skipped because only a project owner can delete them.`
                : null,
            failedIds.length > 0
                ? `${failedIds.length} chat${failedIds.length === 1 ? " was" : "s were"} not deleted because the request failed. ${failedIds.length === 1 ? "It remains" : "They remain"} selected so you can try again.`
                : null,
        ].filter((notice): notice is string => notice !== null);
        if (notices.length > 0)
            setActionNotice({
                title: "Some chats were not deleted",
                message: notices.join(" "),
            });
    }, [chats, selectedChatIds, setProjectChats]);

    return (
        <>
            <ProjectAssistantTable
                renderToolbar={(actions) => <ProjectSectionToolbar actions={actions} />}
                chats={visibleChats}
                filteredChats={filteredChats}
                selectedChatIds={selectedChatIds}
                renamingChatId={renamingChatId}
                renameChatValue={renameChatValue}
                currentUserId={user?.id}
                loading={loading}
                onCreateChat={() => void workspace.createChat()}
                canCreateChat={workspace.canDo("content.edit")}
                onOpenChat={(chatId) =>
                    router.push(
                        `/projects/${projectId}/assistant/chat/${chatId}`,
                    )
                }
                onDeleteChat={handleDeleteChatRow}
                onDeleteSelectedChats={requestDeleteSelectedChats}
                onOwnerOnlyAction={setOwnerOnlyAction}
                submitChatRename={submitChatRename}
                setSelectedChatIds={setSelectedChatIds}
                setRenamingChatId={setRenamingChatId}
                setRenameChatValue={setRenameChatValue}
            />
            <ConfirmPopup
                open={confirmDeleteSelectedOpen && selectedChatIds.length > 0}
                title={
                    selectedChatIds.length === 1
                        ? "Delete chat?"
                        : `Delete ${selectedChatIds.length} chats?`
                }
                message="This cannot be undone."
                confirmLabel="Delete"
                confirmVariant="danger"
                onCancel={() => setConfirmDeleteSelectedOpen(false)}
                onConfirm={() => void handleDeleteSelectedChats()}
            />
            <WarningPopup
                open={!!actionNotice}
                title={actionNotice?.title}
                message={actionNotice?.message}
                onClose={() => setActionNotice(null)}
            />
        </>
    );
}
