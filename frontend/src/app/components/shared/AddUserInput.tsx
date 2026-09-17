"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Loader2, UserPlus } from "lucide-react";
import {
    lookupUserByEmail,
    type UserLookupResult,
} from "@/app/lib/mikeApi";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { cn } from "@/app/lib/utils";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@/shared/ui/LiquidGlassUI";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface AddUserInputProps {
    /**
     * Return `false` to signal the add did NOT happen (skipped or failed) —
     * the email stays in the input for another try. Any other result
     * (including void) counts as success and clears the field.
     */
    onAdd: (user: UserLookupResult) => Promise<void | boolean> | void | boolean;
    validateEmail?: (email: string) => Promise<string | null> | string | null;
    busy?: boolean;
    placeholder?: string;
    autoFocus?: boolean;
    submitLabel?: string;
    submitVariant?: "pill" | "attached";
    /** Rendered between the input and attached submit action. */
    inputEndControl?: ReactNode;
    className?: string;
    /**
     * Refuse addresses that don't already belong to a Mike account.
     *
     * True is right where the address must resolve to a user immediately.
     * Organization invitations are the exceptional flow: they are intended
     * for people who may not have signed up yet, so that caller passes false
     * and validates the format only.
     */
    requireExistingUser?: boolean;
}

export function AddUserInput({
    onAdd,
    validateEmail,
    busy = false,
    placeholder = "Add by email...",
    autoFocus = false,
    submitLabel = "Add user",
    submitVariant = "pill",
    inputEndControl,
    className,
    requireExistingUser = true,
}: AddUserInputProps) {
    const [input, setInput] = useState("");
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const trimmedEmail = input.trim().toLowerCase();
    const showAddButton = trimmedEmail.length > 0;
    const attachedSubmit = submitVariant === "attached";

    async function commitUser() {
        const email = trimmedEmail;
        if (!email || busy || checking) return;
        if (!EMAIL_RE.test(email)) {
            setError("Enter a valid email.");
            return;
        }

        setError(null);
        setChecking(true);
        try {
            const validationError = await validateEmail?.(email);
            if (validationError) {
                setError(validationError);
                return;
            }

            const user = requireExistingUser
                ? await lookupUserByEmail(email)
                : { exists: false, email, display_name: null };
            if (requireExistingUser && !user.exists) {
                setError(`${email} does not belong to a Mike user.`);
                return;
            }

            const result = await onAdd(user);
            if (result !== false) setInput("");
        } catch (err) {
            setError(
                userFacingApiError(
                    err,
                    "Could not add this user. Try again.",
                ),
            );
        } finally {
            setChecking(false);
        }
    }

    function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
        if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            void commitUser();
        }
    }

    return (
        <div>
            <div
                data-slot={
                    attachedSubmit
                        ? "add-user-input-group"
                        : "add-user-input"
                }
                className={cn(
                    `flex min-h-10 items-center rounded-xl ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl transition-colors focus-within:ring-2 focus-within:ring-blue-500/40 focus-within:ring-offset-2`,
                    attachedSubmit
                        ? "gap-0 overflow-hidden pl-3"
                        : "gap-2 px-3 py-1.5",
                    className,
                )}
            >
                <UserPlus
                    className={cn(
                        "h-3.5 w-3.5 shrink-0 text-gray-400",
                        attachedSubmit && "mr-2",
                    )}
                />
                <input
                    type="email"
                    value={input}
                    onChange={(event) => {
                        setInput(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className={cn(
                        "min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400",
                        attachedSubmit && "h-10 py-2",
                    )}
                    autoFocus={autoFocus}
                />
                {attachedSubmit ? inputEndControl : null}
                {attachedSubmit ? (
                    <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void commitUser()}
                        disabled={!showAddButton || busy || checking}
                        title={submitLabel}
                        className="flex h-10 shrink-0 items-center justify-center gap-1.5 self-stretch pl-3 pr-4 text-xs font-medium text-blue-600 transition-colors hover:bg-blue-50 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-gray-300"
                    >
                        {(busy || checking) && (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        Add
                    </button>
                ) : showAddButton ? (
                    <PillButtonUI
                        tone="blue"
                        size="xs"
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void commitUser()}
                        disabled={busy || checking}
                        loading={busy || checking}
                        title={submitLabel}
                        className="shrink-0"
                    >
                        Add
                    </PillButtonUI>
                ) : null}
            </div>
            {error && <p className="mt-1.5 text-xs text-red-500">{error}</p>}
        </div>
    );
}
