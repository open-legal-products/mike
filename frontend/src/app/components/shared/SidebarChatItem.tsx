"use client";

import { useState, useRef } from "react";
import {
    Columns2,
    MoreHorizontal,
    Pencil,
    Trash2,
    Users,
    Loader2,
} from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { RenameModal } from "@/app/components/modals/RenameModal";
import { PermissionDeniedPopup } from "@/app/components/popups/PermissionDeniedPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { can, roleFrom } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { Chat } from "@/app/components/shared/types";
import { ChatSkeuoIcon } from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ChatAccessModal } from "@/app/components/assistant/ChatAccessModal";
import { cn } from "@/app/lib/utils";
import {
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
} from "@/app/components/ui/liquid-surface";

// Hover slide for titles too long for the row: paced by distance so a long
// title glides at the same unhurried speed as a short one.
const TITLE_SLIDE_MS_PER_PX = 25;
const TITLE_SLIDE_MIN_MS = 800;
const TITLE_SLIDE_BACK_MS = 600;

interface Props {
    chat: Chat;
    isActive: boolean;
    onSelect: () => void;
    projectName?: string;
    responseStatus?: "loading" | "complete";
    /** Offers showing this chat beside the one on screen. */
    onOpenInSideChat?: () => void;
}

export function SidebarChatItem({
    chat,
    isActive,
    onSelect,
    projectName,
    responseStatus,
    onOpenInSideChat,
}: Props) {
    const { renameChat, deleteChat } = useChatHistoryContext();
    const [renameOpen, setRenameOpen] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [titleSlide, setTitleSlide] = useState({
        offset: 0,
        duration: TITLE_SLIDE_BACK_MS,
    });
    const [gate, setGate] = useState<{
        action: string;
        requiredRole: "owner" | "editor";
    } | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [renameError, setRenameError] = useState<string | null>(null);
    const titleTextRef = useRef<HTMLSpanElement>(null);
    // Chats joined the project role ladder: rename is content collaboration
    // (member+, the tier the server's PATCH asks for) and delete sits at the
    // top (the creator — is_owner ⇒ admin via roleFrom — or a project
    // admin). The overview RPC serves BOTH is_owner and access_role on every
    // row — the same verdict its own visibility predicate filtered on — so
    // this gate reflects what the server would actually answer; roleFrom
    // fails closed to viewer when a row carries neither field.
    const role = roleFrom(chat);
    const canRename = can(role, "content.edit");
    const canShare = can(role, "access.manage");
    const canDelete = can(role, "container.delete");
    // One label for the row's tooltip and its accessible name, so the
    // "Shared" marker rendered beside the title is part of both.
    const chatTitle = chat.title ?? "Untitled chat";
    const rowLabel = [
        projectName ? `${projectName}: ${chatTitle}` : chatTitle,
        chat.is_owner === false ? "(Shared)" : null,
        responseStatus === "loading"
            ? "(Response loading)"
            : responseStatus === "complete"
              ? "(Response complete)"
              : null,
    ]
        .filter(Boolean)
        .join(" ");

    // The actions trigger is zero-width until the row is hovered. While its
    // menu is open the row must stay in its revealed layout, or the trigger
    // collapses when the pointer leaves and the menu anchored to it jumps.
    const actionsRevealed = isActive || menuOpen;

    const handleRenameSave = async (title: string) => {
        setRenaming(true);
        try {
            await renameChat(chat.id, title);
            setRenameOpen(false);
        } catch (error) {
            // The context put the old title back; without this the user
            // watches their edit silently revert — the rename twin of the
            // surfaced delete failure below. The modal stays open so the
            // typed title is still there to retry.
            setRenameError(
                userFacingApiError(
                    error,
                    "The chat could not be renamed. Please try again.",
                ),
            );
        } finally {
            setRenaming(false);
        }
    };

    // Runs on hover and on keyboard focus, so a keyboard user can read a
    // clipped title too. The title stays revealed until both have ended;
    // focus from a click does not count, or the opened chat's row would stay
    // slid after the pointer leaves.
    const revealTitle = (button: HTMLButtonElement) => {
        const text = titleTextRef.current;
        if (!text) return;
        const style = getComputedStyle(button);
        const available =
            button.clientWidth -
            (parseFloat(style.paddingLeft) || 0) -
            (parseFloat(style.paddingRight) || 0);
        const overflow = Math.ceil(text.offsetWidth - available);
        if (overflow <= 0) return;
        setTitleSlide({
            offset: overflow,
            duration: Math.max(
                TITLE_SLIDE_MIN_MS,
                overflow * TITLE_SLIDE_MS_PER_PX,
            ),
        });
    };

    const resetTitle = () => {
        setTitleSlide({ offset: 0, duration: TITLE_SLIDE_BACK_MS });
    };

    return (
        <div
            className={cn(
                "group relative flex h-8 w-full items-center rounded-md transition-colors",
                isActive
                    ? `${LIQUID_GLASS_SELECTED_CLASS} pr-1`
                    : menuOpen
                      ? `pr-1 ${LIQUID_GLASS_HOVER_CLASS}`
                      : `pr-3 ${LIQUID_GLASS_HOVER_CLASS} hover:pr-1`,
            )}
        >
                {/* 16px icon slot + ml-2/pl-2 match the top nav rows'
                    px-2 / w-4 icon / gap-2, so icons and titles line up. */}
                <span className="ml-2 flex h-4 w-4 shrink-0 items-center justify-center">
                    {responseStatus === "loading" ? (
                        <Loader2
                            role="status"
                            aria-label={`${chatTitle} response loading`}
                            className="h-3.5 w-3.5 animate-spin text-blue-600 motion-reduce:animate-none"
                        />
                    ) : (
                        <ChatSkeuoIcon
                            tone={
                                responseStatus === "complete"
                                    ? "green"
                                    : "blue"
                            }
                            className="h-3.5 w-3.5"
                        />
                    )}
                </span>
                <button
                    type="button"
                    onClick={onSelect}
                    onMouseEnter={(e) => revealTitle(e.currentTarget)}
                    onMouseLeave={(e) => {
                        if (!e.currentTarget.matches(":focus-visible")) resetTitle();
                    }}
                    onFocus={(e) => {
                        if (e.currentTarget.matches(":focus-visible"))
                            revealTitle(e.currentTarget);
                    }}
                    onBlur={(e) => {
                        if (!e.currentTarget.matches(":hover")) resetTitle();
                    }}
                    // The row owns the hover fill, so it draws the ring.
                    data-focus-fill
                    className={cn(
                        "min-w-0 flex-1 overflow-hidden whitespace-nowrap py-1 pl-2 text-left text-xs outline-none",
                        isActive
                            ? "pr-3 text-gray-900"
                            : menuOpen
                              ? "pr-3 text-gray-700"
                              : "pr-0 text-gray-700 group-hover:pr-3",
                    )}
                    // The "Shared" marker sits in a SIBLING element, so
                    // neither the tooltip nor the accessible name of this
                    // row carried it: a screen-reader user heard exactly
                    // what the owner of the thread hears. It belongs in
                    // both.
                    title={rowLabel}
                    aria-label={rowLabel}
                >
                    <span
                        ref={titleTextRef}
                        className="inline-block transition-transform ease-in-out motion-reduce:transition-none"
                        style={{
                            transform: `translateX(-${titleSlide.offset}px)`,
                            transitionDuration: `${titleSlide.duration}ms`,
                        }}
                    >
                        {projectName && (
                            <span className="text-gray-400 font-normal">{projectName}: </span>
                        )}
                        {chat.title ?? "Untitled chat"}
                    </span>
                </button>

                {/* Somebody else's thread. get_chats_overview now lists
                    colleagues' organization-project chats alongside the
                    caller's own, and nothing in the row said which was
                    which — the same list, the same weight, so a rename
                    or a delete could land on a colleague's work by
                    mistake. Plain text, not a pill: this is an
                    informational label (AGENTS.md).

                    Strictly `=== false`: a row that carries no is_owner
                    at all has told us nothing, and marking it "Shared"
                    would be a claim we cannot make. */}
                {chat.is_owner === false && (
                    // `text-[10px] text-gray-400` measured about 2.6:1 —
                    // below the 4.5:1 the accessibility baseline requires,
                    // on the one word in the row that says whose work this
                    // is. text-xs on the muted gray that does meet it.
                    <span className="mr-1 shrink-0 text-xs text-gray-500">
                        Shared
                    </span>
                )}

                <Dropdown open={menuOpen} onOpenChange={setMenuOpen}>
                    <DropdownTrigger asChild>
                        <button
                            type="button"
                            aria-label={`Actions for ${chat.title ?? "Untitled chat"}`}
                            className={`flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded-md bg-transparent text-gray-500 opacity-0 transition-opacity hover:text-gray-900 ${
                                actionsRevealed
                                    ? "w-6 opacity-100"
                                    : "pointer-events-none group-hover:w-6 group-hover:pointer-events-auto group-hover:opacity-100"
                            }`}
                        >
                            <MoreHorizontal className="h-4 w-4" />
                        </button>
                    </DropdownTrigger>
                    <DropdownContent align="end">
                        {onOpenInSideChat && (
                            // Two chats need a wide page.
                            <DropdownItem
                                onSelect={onOpenInSideChat}
                                className="max-md:hidden"
                            >
                                <Columns2 className="mr-2 h-4 w-4" />
                                Open in side chat
                            </DropdownItem>
                        )}
                        <DropdownItem
                            onSelect={() => {
                                if (!canShare) {
                                    setGate({
                                        action: "share this chat",
                                        requiredRole: "owner",
                                    });
                                    return;
                                }
                                setShareOpen(true);
                            }}
                        >
                            <Users className="mr-2 h-4 w-4" />
                            Share
                        </DropdownItem>
                        <DropdownItem
                            onSelect={() => {
                                if (!canRename) {
                                    setGate({
                                        action: "rename this chat",
                                        requiredRole: "editor",
                                    });
                                    return;
                                }
                                setRenameOpen(true);
                            }}
                        >
                            <Pencil className="mr-2 h-4 w-4" />
                            Rename
                        </DropdownItem>
                        <DropdownItem
                            onSelect={() => {
                                if (!canDelete) {
                                    setGate({
                                        action: "delete this chat",
                                        requiredRole: "owner",
                                    });
                                    return;
                                }
                                deleteChat(chat.id).catch((error) => {
                                    setDeleteError(
                                        userFacingApiError(
                                            error,
                                            "The chat could not be deleted. Please try again.",
                                        ),
                                    );
                                });
                            }}
                            className="text-red-600 focus:text-red-600"
                        >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                        </DropdownItem>
                    </DropdownContent>
                </Dropdown>
            {/* TODO(contacts): no `contacts` to pass. The sidebar rows come
                from get_chats_overview and GET /chat/:id serves only
                chat + is_owner + access_role, so no ranked admin list
                reaches a chat surface and the popup's "Ask …" line can never
                render here. Needs the server to return the shape project
                detail already returns as `admin_contacts`. */}
            <PermissionDeniedPopup
                open={!!gate}
                action={gate?.action}
                requiredRole={gate?.requiredRole}
                onClose={() => setGate(null)}
            />
            <RenameModal
                open={renameOpen}
                breadcrumbs={["Assistant", "Rename Chat"]}
                label="Chat title"
                initialValue={chat.title?.trim() || "Untitled chat"}
                saving={renaming}
                onClose={() => {
                    if (!renaming) setRenameOpen(false);
                }}
                onSave={(title) => void handleRenameSave(title)}
            />
            <WarningPopup
                open={!!deleteError}
                title="Chat not deleted"
                message={deleteError}
                onClose={() => setDeleteError(null)}
            />
            <WarningPopup
                open={!!renameError}
                title="Chat not renamed"
                message={renameError}
                onClose={() => setRenameError(null)}
            />
            {shareOpen ? (
                <ChatAccessModal
                    open={shareOpen}
                    chat={chat}
                    onClose={() => setShareOpen(false)}
                />
            ) : null}
        </div>
    );
}
