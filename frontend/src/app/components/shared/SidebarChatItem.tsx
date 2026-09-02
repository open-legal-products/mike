"use client";

import { useState, useRef, useEffect } from "react";
import { MoreHorizontal, Pencil, Trash2, Check, X } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { useAuth } from "@/app/contexts/AuthContext";
import { PermissionDeniedPopup } from "@/app/components/popups/PermissionDeniedPopup";
import type { Chat } from "@/app/components/shared/types";
import { ChatSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/app/components/ui/liquid-surface";

interface Props {
    chat: Chat;
    isActive: boolean;
    onSelect: () => void;
    projectName?: string;
}

export function SidebarChatItem({ chat, isActive, onSelect, projectName }: Props) {
    const { renameChat, deleteChat } = useChatHistoryContext();
    const { user } = useAuth();
    const [isRenaming, setIsRenaming] = useState(false);
    const [editTitle, setEditTitle] = useState(chat.title ?? "");
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const editInputRef = useRef<HTMLInputElement>(null);
    // The sidebar shows collaborator chats from projects the user can reach,
    // but PATCH/DELETE /chats/:id both filter on `.eq("user_id", userId)`
    // (backend/src/routes/chat.ts) — creator-only, with no role path at all.
    // So this is a row-ownership check, not a rung on the project ladder.
    const isChatOwner = !!user?.id && chat.user_id === user.id;

    useEffect(() => {
        if (isRenaming) editInputRef.current?.focus();
    }, [isRenaming]);

    const handleRenameSave = async () => {
        const trimmed = editTitle.trim();
        if (trimmed) await renameChat(chat.id, trimmed);
        setIsRenaming(false);
    };

    const handleRenameCancel = () => {
        setIsRenaming(false);
        setEditTitle(chat.title ?? "");
    };

    return (
        <div
            className={cn(
                "group relative flex h-8 w-full items-center rounded-md transition-colors",
                isActive
                    ? `${LIQUID_GLASS_SELECTED_CLASS} pr-1`
                    : `pr-3 ${LIQUID_GLASS_HOVER_CLASS} hover:pr-1`,
            )}
        >
            {isRenaming ? (
                <div className="flex items-center w-full px-2 py-1">
                    <input
                        ref={editInputRef}
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void handleRenameSave();
                            if (e.key === "Escape") handleRenameCancel();
                        }}
                        className={`flex-1 rounded px-1 py-0.5 text-sm ${LIQUID_GLASS_SUBTLE_CLASS} focus:outline-none focus:ring-1 focus:ring-blue-500`}
                    />
                    <button
                        onClick={() => void handleRenameSave()}
                        className="ml-1.5 py-2 hover:bg-gray-200 rounded text-green-600"
                    >
                        <Check className="h-3 w-3" />
                    </button>
                    <button
                        onClick={handleRenameCancel}
                        className="ml-1 py-2 hover:bg-gray-200 rounded text-red-600"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            ) : (
                <>
                    <ChatSkeuoIcon className="ml-2.5 h-3.5 w-3.5 shrink-0" />
                    <button
                        onClick={onSelect}
                        onMouseEnter={(e) => {
                            const el = e.currentTarget;
                            const overflow = el.scrollWidth - el.clientWidth;
                            if (overflow > 0) el.scrollTo({ left: overflow, behavior: "smooth" });
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.scrollTo({ left: 0, behavior: "smooth" });
                        }}
                        className={cn(
                            "min-w-0 flex-1 overflow-x-hidden whitespace-nowrap scrollbar-none py-1 pl-2 text-left text-xs",
                            isActive
                                ? "pr-3 text-gray-900"
                                : "pr-0 text-gray-700 group-hover:pr-3",
                        )}
                        title={projectName ? `${projectName}: ${chat.title ?? "Untitled chat"}` : (chat.title ?? "Untitled chat")}
                    >
                        {projectName && (
                            <span className="text-gray-400 font-normal">{projectName}: </span>
                        )}
                        {chat.title ?? "Untitled chat"}
                    </button>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                className={`flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded-md bg-transparent text-gray-500 opacity-0 transition-opacity hover:text-gray-900 ${
                                    isActive
                                        ? "w-6 opacity-100"
                                        : "pointer-events-none group-hover:w-6 group-hover:pointer-events-auto group-hover:opacity-100"
                                }`}
                            >
                                <MoreHorizontal className="h-4 w-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <LiquidDropdownContent align="end" className="z-101">
                            <LiquidDropdownItem
                                onClick={() => {
                                    if (!isChatOwner) {
                                        setOwnerOnlyAction("rename it");
                                        return;
                                    }
                                    setEditTitle(chat.title ?? "");
                                    setIsRenaming(true);
                                }}
                            >
                                <Pencil className="mr-2 h-4 w-4" />
                                Rename
                            </LiquidDropdownItem>
                            <LiquidDropdownItem
                                onClick={() => {
                                    if (!isChatOwner) {
                                        setOwnerOnlyAction("delete it");
                                        return;
                                    }
                                    void deleteChat(chat.id);
                                }}
                                className="text-red-600 focus:text-red-600"
                            >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                            </LiquidDropdownItem>
                        </LiquidDropdownContent>
                    </DropdownMenu>
                </>
            )}
            <PermissionDeniedPopup
                open={!!ownerOnlyAction}
                title="Chat creator only"
                // Spelled out rather than left to the role-based default,
                // which would have claimed "Only an admin can rename this
                // chat." No admin can: the server asks who created the row,
                // not what role the asker holds. For the same reason there is
                // no "ask …" line here — there is nobody to ask, because
                // nobody can grant this.
                message={
                    ownerOnlyAction
                        ? `Only the person who started this chat can ${ownerOnlyAction}.`
                        : undefined
                }
                onClose={() => setOwnerOnlyAction(null)}
            />
        </div>
    );
}
