"use client";

import { useState } from "react";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { WarningPopup } from "@/app/components/popups/WarningPopup";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { userFacingApiError } from "@/app/lib/userFacingError";

export function LeaveChatPopup({
    chatId,
    onClose,
    onLeft,
}: {
    chatId: string;
    onClose: () => void;
    onLeft: () => void;
}) {
    const { leaveChat } = useChatHistoryContext();
    const [leaving, setLeaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function confirmLeave() {
        if (leaving) return;
        setLeaving(true);
        try {
            await leaveChat(chatId);
            onClose();
            onLeft();
        } catch (cause) {
            setError(userFacingApiError(
                cause,
                "The chat could not be left. Please try again.",
            ));
        } finally {
            setLeaving(false);
        }
    }

    return (
        <>
            <ConfirmPopup
                open={!error}
                title="Leave chat?"
                message="Your shared access will be removed. An owner can share this chat with you again."
                confirmLabel="Leave"
                confirmStatus={leaving ? "loading" : "idle"}
                onConfirm={() => void confirmLeave()}
                onCancel={() => { if (!leaving) onClose(); }}
            />
            <WarningPopup
                open={!!error}
                title="Chat not left"
                message={error}
                onClose={() => { setError(null); onClose(); }}
            />
        </>
    );
}
