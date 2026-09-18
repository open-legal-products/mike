"use client";

import { useCallback, useEffect, useState } from "react";
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
import { notifyError } from "@/app/lib/userFacingError";
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

    // Bumped by the "Retry" on a failed load so the effect below refetches.
    const [accessReloadKey, setAccessReloadKey] = useState(0);
    const reportAccessFailure = useCallback(
        (error: unknown, action: string) => {
            notifyError(error, {
                action,
                dedupeKey: `chat-access:${chat.id}`,
                onRetry: () => setAccessReloadKey((key) => key + 1),
            });
        },
        [chat.id],
    );

    useEffect(() => {
        if (!open || !canManage) return;
        let cancelled = false;
        getChatAccess(chat.id)
            .then((nextAccess) => {
                if (!cancelled) {
                    setAccessState({ chatId: chat.id, value: nextAccess });
                }
            })
            .catch((error) => {
                // An empty grant list is indistinguishable from "shared with
                // nobody", so a failed load has to say that it failed.
                if (!cancelled) {
                    reportAccessFailure(
                        error,
                        "load who this chat is shared with",
                    );
                }
            });
        return () => {
            cancelled = true;
        };
    }, [accessReloadKey, canManage, chat.id, open, reportAccessFailure]);

    return (
        <AccessModal
            open={open}
            onClose={onClose}
            resource={{
                id: chat.id,
                owner_display_name: chat.creator_display_name ?? null,
            }}
            fetchAccess={getChatPeople}
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
                // Role-derived, so the Share Access label and input are there
                // the moment the modal opens. Waiting for the access payload
                // blanked them out mid-fetch and then popped them in; every
                // other resource passes its capability straight through, and
                // the roster below carries its own loading state.
                canManage,
                onGrant: async (email, role) => {
                    await grantChatAccess(chat.id, email, role);
                    // The grant itself succeeded; a failed re-read is its own
                    // problem and must not be reported as a failed share.
                    await refreshAccess().catch((error) =>
                        reportAccessFailure(
                            error,
                            "refresh who this chat is shared with",
                        ),
                    );
                },
                onRevoke: async (email) => {
                    await revokeChatAccess(chat.id, email);
                    await refreshAccess().catch((error) =>
                        reportAccessFailure(
                            error,
                            "refresh who this chat is shared with",
                        ),
                    );
                },
            }}
        />
    );
}
