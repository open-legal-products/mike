"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { deleteChat, renameChat } from "@/app/lib/mikeApi";
import { deleteTabularReviewsWithConcurrency } from "@/app/lib/deleteTabularReviewsWithConcurrency";
import { restoreOptimisticallyDeletedRows } from "@/app/lib/optimisticRows";
import { ProjectAssistantTable } from "@/app/components/projects/ProjectAssistantTable";
import {
    ProjectSectionToolbar,
    useProjectWorkspace,
} from "@/app/components/projects/ProjectWorkspace";
import type { Chat } from "@/app/components/shared/types";
import { useAuth } from "@/app/contexts/AuthContext";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";

interface Props {
    params: Promise<{ id: string }>;
}

function SelectedChatActions({
    selectedCount,
    open,
    onOpenChange,
    onDelete,
}: {
    selectedCount: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDelete: () => void;
}) {
    if (selectedCount === 0) return null;

    return (
        <div className="relative">
            <TabPillButton
                onClick={() => onOpenChange(!open)}
            >
                Actions
                <ChevronDown className="h-3.5 w-3.5" />
            </TabPillButton>
            {open && (
                <div className="absolute right-0 top-full z-[120] mt-1 w-36 overflow-hidden rounded-lg border border-white/60 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_12px_32px_rgba(15,23,42,0.14)] backdrop-blur-xl">
                    <button
                        onClick={onDelete}
                        className="w-full px-3 py-1.5 text-left text-xs text-red-600 transition-colors hover:bg-red-50"
                    >
                        Delete
                    </button>
                </div>
            )}
        </div>
    );
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
    const [actionsOpen, setActionsOpen] = useState(false);
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
    const allChatsSelected =
        filteredChats.length > 0 &&
        filteredChats.every((c) => selectedChatIds.includes(c.id));
    const someChatsSelected =
        !allChatsSelected &&
        filteredChats.some((c) => selectedChatIds.includes(c.id));

    async function submitChatRename(chatId: string) {
        const trimmed = renameChatValue.trim();
        setRenamingChatId(null);
        if (!trimmed) return;
        await renameChat(chatId, trimmed);
        setProjectChats((prev) =>
            (prev ?? []).map((chat) =>
                chat.id === chatId ? { ...chat, title: trimmed } : chat,
            ),
        );
    }

    async function handleDeleteChatRow(chat: Chat) {
        if (user?.id && chat.user_id !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        setProjectChats((prev) => (prev ?? []).filter((c) => c.id !== chat.id));
        try {
            await deleteChat(chat.id);
        } catch (error) {
            setProjectChats((current) =>
                restoreOptimisticallyDeletedRows(
                    current ?? [],
                    chats,
                    [chat.id],
                ),
            );
            throw error;
        }
    }

    const handleDeleteSelectedChats = useCallback(async () => {
        const ids = [...selectedChatIds];
        setActionsOpen(false);
        const owned = ids.filter((id) => {
            const chat = chats.find((c) => c.id === id);
            return !chat || chat.user_id === user?.id;
        });
        const blocked = ids.length - owned.length;
        setSelectedChatIds([]);
        setProjectChats((prev) =>
            (prev ?? []).filter((chat) => !owned.includes(chat.id)),
        );
        const { failedIds } = await deleteTabularReviewsWithConcurrency(
            owned,
            deleteChat,
        );
        if (failedIds.length > 0) {
            setProjectChats((current) =>
                restoreOptimisticallyDeletedRows(
                    current ?? [],
                    chats,
                    failedIds,
                ),
            );
            setSelectedChatIds(failedIds);
        }
        if (blocked > 0) {
            setOwnerOnlyAction(
                `delete ${blocked} of the selected chats - only the chat creator can delete a chat`,
            );
        }
    }, [chats, selectedChatIds, setOwnerOnlyAction, setProjectChats, user?.id]);

    return (
        <>
            <ProjectSectionToolbar
                actions={selectedChatIds.length > 0 ? (
                    <SelectedChatActions
                        selectedCount={selectedChatIds.length}
                        open={actionsOpen}
                        onOpenChange={setActionsOpen}
                        onDelete={() => void handleDeleteSelectedChats()}
                    />
                ) : undefined}
            />
            <ProjectAssistantTable
                chats={visibleChats}
                filteredChats={filteredChats}
                selectedChatIds={selectedChatIds}
                allChatsSelected={allChatsSelected}
                someChatsSelected={someChatsSelected}
                renamingChatId={renamingChatId}
                renameChatValue={renameChatValue}
                currentUserId={user?.id}
                loading={loading}
                onCreateChat={() => void workspace.createChat()}
                onOpenChat={(chatId) =>
                    router.push(
                        `/projects/${projectId}/assistant/chat/${chatId}`,
                    )
                }
                onDeleteChat={handleDeleteChatRow}
                onDeleteSelectedChats={handleDeleteSelectedChats}
                onOwnerOnlyAction={setOwnerOnlyAction}
                submitChatRename={submitChatRename}
                setSelectedChatIds={setSelectedChatIds}
                setRenamingChatId={setRenamingChatId}
                setRenameChatValue={setRenameChatValue}
            />
        </>
    );
}
