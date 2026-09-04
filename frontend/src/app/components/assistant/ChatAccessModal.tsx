"use client";

import { useCallback, useState } from "react";
import { AccessModal } from "@/app/components/modals/AccessModal";
import { useAuth } from "@/app/contexts/AuthContext";
import {
    getChatAccess,
    getChatPeople,
    grantChatAccess,
    revokeChatAccess,
    type ContentAccess,
} from "@/app/lib/mikeApi";
import { can, roleFrom } from "@/app/lib/permissions";
import type { Chat } from "@/app/components/shared/types";

interface Props {
    open: boolean;
    chat: Chat;
    onClose: () => void;
}

export function ChatAccessModal({ open, chat, onClose }: Props) {
    const { user } = useAuth();
    const [accessState, setAccessState] = useState<{
        chatId: string;
        value: ContentAccess;
    } | null>(null);
    const access =
        accessState?.chatId === chat.id ? accessState.value : null;
    const canManage = can(roleFrom(chat), "access.manage");

    const refreshAccess = useCallback(async () => {
        const nextAccess = await getChatAccess(chat.id);
        setAccessState({ chatId: chat.id, value: nextAccess });
    }, [chat.id]);

    /**
     * Load the roster and, for a manager, the grants — as one request from
     * AccessModal's point of view, so both share its error channel.
     *
     * The owner-only grant fetch used to run in its own effect whose
     * `.catch` was a comment. When it failed, `access` stayed null,
     * `canManage && access !== null` fell to false, and the owner got a
     * modal that was silently read-only with nothing on screen saying why —
     * indistinguishable from genuinely not being allowed to manage it.
     * Rejecting here instead routes the failure into the modal's own error
     * line (userFacingApiError, so a 4xx shows the server's wording).
     */
    const loadPeople = useCallback(
        async (chatId: string) => {
            const people = await getChatPeople(chatId);
            if (canManage) {
                const nextAccess = await getChatAccess(chatId);
                setAccessState({ chatId, value: nextAccess });
            }
            return people;
        },
        [canManage],
    );

    return (
        <AccessModal
            open={open}
            onClose={onClose}
            resource={{
                id: chat.id,
                owner_display_name: chat.creator_display_name ?? null,
            }}
            fetchAccess={loadPeople}
            currentUserEmail={user?.email ?? null}
            breadcrumb={[
                "Assistant",
                chat.title?.trim() || "Untitled chat",
                "Access",
            ]}
            access={{
                grants: access?.grants ?? [],
                orgId: access?.org_id ?? chat.org_id ?? null,
                inheritedFromProjectId:
                    access?.inherited_from_project_id ??
                    chat.project_id ??
                    null,
                ownerLabel: "Owners",
                canManage: canManage && access !== null,
                onGrant: async (email, role) => {
                    await grantChatAccess(chat.id, email, role);
                    await refreshAccess();
                },
                onRevoke: async (email) => {
                    await revokeChatAccess(chat.id, email);
                    await refreshAccess();
                },
            }}
        />
    );
}
