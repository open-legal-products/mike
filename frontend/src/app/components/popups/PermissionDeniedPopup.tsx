"use client";

import { Lock } from "lucide-react";
import { WarningPopup } from "../popups/WarningPopup";
import {
    PROJECT_ROLE_LABELS,
    type ProjectRole,
} from "@/app/lib/permissions";

/** Anyone the user could ask for access, as the API returns them. */
export interface AccessContact {
    email?: string | null;
    display_name?: string | null;
}

interface Props {
    open: boolean;
    onClose: () => void;
    /** Short headline above the body. Defaults from `requiredRole`. */
    title?: string;
    /** Sentence describing what the user tried to do. */
    action?: string;
    /**
     * The lowest role that may perform the action. "admin" covers settings,
     * sharing and deletion; "member" covers everything a viewer may not do.
     */
    requiredRole?: Extract<ProjectRole, "admin" | "member">;
    /**
     * People who can grant the access, in the order the server ranked them
     * (creator first, then direct admins, then the organization's admins).
     * The first one with an address is offered.
     */
    contacts?: AccessContact[] | null;
    /** Override the default message entirely. */
    message?: string;
}

const ROLE_SUBJECT: Record<
    NonNullable<Props["requiredRole"]>,
    { title: string; subject: string }
> = {
    admin: { title: "Admin-only action", subject: "an admin" },
    member: { title: "Members only", subject: "a member" },
};

/**
 * Fold several rows' contact lists into one, keeping the server's ranking
 * (creator, then direct admins, then organization admins) and dropping
 * repeats. A bulk action refused across several rows still has to name one
 * person, and the same admin usually appears on all of them.
 */
export function mergeAccessContacts(
    lists: (AccessContact[] | null | undefined)[],
): AccessContact[] {
    const seen = new Set<string>();
    const merged: AccessContact[] = [];
    for (const list of lists) {
        for (const contact of list ?? []) {
            const key = contact.email?.trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            merged.push(contact);
        }
    }
    return merged;
}

/** The first contact with an address, rendered as a name plus its email. */
function pickContact(contacts: AccessContact[] | null | undefined) {
    for (const contact of contacts ?? []) {
        const email = contact.email?.trim();
        if (!email) continue;
        const name = contact.display_name?.trim();
        return { email, name: name || null };
    }
    return null;
}

/**
 * "You don't have permission" popup, shown when the caller's role does not
 * allow an action (change sharing, rename, delete, …), instead of letting the
 * server's silent 403/404 look like a bug.
 *
 * The contact line is the point of the component. A refusal that cannot say
 * who to ask is a dead end — which is exactly what shipped before: the popup
 * guarded its email line on a field the project endpoint never returned, so
 * the line could never render. It now takes the server's ranked admin
 * contacts, so an organization member refused on a colleague's project sees a
 * real person to ask.
 */
export function PermissionDeniedPopup({
    open,
    onClose,
    title,
    action,
    requiredRole = "admin",
    contacts,
    message,
}: Props) {
    if (!open) return null;

    const subject = ROLE_SUBJECT[requiredRole];
    const heading = title ?? subject.title;
    const body =
        message ??
        (action
            ? `Only ${subject.subject} can ${action}.`
            : `Only ${subject.subject} can perform this action.`);
    const contact = pickContact(contacts);

    return (
        <WarningPopup
            open={open}
            onClose={onClose}
            title={heading}
            message={body}
            icon={<Lock className="h-3.5 w-3.5 shrink-0 text-red-600" />}
        >
            {contact && (
                <p className="mt-1 text-xs text-gray-600">
                    Ask{" "}
                    <span className="text-gray-600">
                        {contact.name
                            ? `${contact.name} (${contact.email})`
                            : contact.email}
                    </span>{" "}
                    if you need {PROJECT_ROLE_LABELS[requiredRole].toLowerCase()}{" "}
                    access.
                </p>
            )}
        </WarningPopup>
    );
}
