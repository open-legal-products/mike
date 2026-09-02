"use client";

import { useState } from "react";
import type { KeyboardEvent } from "react";
import { Loader2, UserPlus } from "lucide-react";
import {
    lookupUserByEmail,
    type UserLookupResult,
} from "@/app/lib/mikeApi";
import { PillButton } from "@/app/components/ui/pill-button";
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
    className?: string;
    /**
     * Refuse addresses that don't already belong to a Mike account.
     *
     * True is right where the address must resolve to a user immediately. It
     * is wrong for the two flows that address people who have not signed up
     * yet: an access grant is claimed by email whenever its recipient does
     * create an account, and an organization invitation is sent precisely so
     * somebody outside can join. Those pass false and validate the format
     * only.
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
    className,
    requireExistingUser = true,
}: AddUserInputProps) {
    const [input, setInput] = useState("");
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const trimmedEmail = input.trim().toLowerCase();
    const showAddButton = trimmedEmail.length > 0;

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
                className={cn(
                    `flex min-h-10 items-center gap-2 rounded-xl px-3 py-1.5 ${LIQUID_GLASS_SUBTLE_CLASS} backdrop-blur-xl transition-colors`,
                    className,
                )}
            >
                <UserPlus className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <input
                    type="email"
                    value={input}
                    onChange={(event) => {
                        setInput(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    className="min-w-0 flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
                    autoFocus={autoFocus}
                />
                {showAddButton && (
                    <PillButton
                        tone="blue"
                        size="sm"
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => void commitUser()}
                        disabled={busy || checking}
                        title={submitLabel}
                        className="h-6 shrink-0 px-2.5 text-[11px] leading-none"
                    >
                        {(busy || checking) && (
                            <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        Add
                    </PillButton>
                )}
            </div>
            {error && <p className="mt-1.5 text-xs text-red-500">{error}</p>}
        </div>
    );
}
