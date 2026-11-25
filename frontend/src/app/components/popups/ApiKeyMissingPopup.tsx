"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { WarningPopup } from "../popups/WarningPopup";
import {
    providerKeysHref,
    useWorkspaceSettingsScope,
} from "@/app/hooks/useWorkspaceSettingsScope";

interface Props {
    open: boolean;
    onClose: () => void;
    /** Optional override for the body sentence. */
    message?: string;
    /** Optional override for the heading — e.g. a rejected key, not a missing one. */
    title?: string;
}

export function ApiKeyMissingPopup({
    open,
    onClose,
    message,
    title,
}: Props) {
    const router = useRouter();
    const scope = useWorkspaceSettingsScope();
    if (!open) return null;

    // Keys are managed where the active workspace's keys live: the caller's
    // own Settings in Personal, the organization's settings for its owners
    // and admins. A member has nowhere to go, so is offered no button.
    const keysHref = providerKeysHref(scope);
    const body =
        message ??
        (scope.kind === "managed"
            ? `No models are enabled in ${scope.orgName} yet. Ask one of its owners or admins to add an API key.`
            : "You haven't enabled any models yet. Add an API key in settings to get started.");

    const handleGoToSettings = (href: string) => {
        onClose();
        router.push(href);
    };

    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title={title ?? "API key required"}
            message={body}
            icon={
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600" />
            }
            primaryAction={
                keysHref
                    ? {
                          label: "Go to settings",
                          onClick: () => handleGoToSettings(keysHref),
                      }
                    : undefined
            }
        />
    );
}
