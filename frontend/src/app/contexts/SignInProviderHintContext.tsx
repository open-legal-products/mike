"use client";

import { createContext, useContext } from "react";
import type { SignInProviderHint } from "@/app/lib/signInProviderHint";

const SignInProviderHintContext = createContext<SignInProviderHint | null>(null);

/** Hands the server-rendered provider hint to the sign-in screens below it. */
export function SignInProviderHintProvider({
    hint,
    children,
}: {
    hint: SignInProviderHint | null;
    children: React.ReactNode;
}) {
    return (
        <SignInProviderHintContext.Provider value={hint}>
            {children}
        </SignInProviderHintContext.Provider>
    );
}

/** The server's provider hint, or `null` when it had none. */
export function useSignInProviderHint(): SignInProviderHint | null {
    return useContext(SignInProviderHintContext);
}
