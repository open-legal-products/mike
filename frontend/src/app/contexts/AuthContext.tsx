"use client";

import React, {
    createContext,
    useContext,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    ReactNode,
} from "react";
import {
    clearLegacyBrowserAuthStorage,
    getAuthSession,
    logout,
    updateAuthEmail,
    updateAuthPassword,
    type AuthUser,
} from "@/app/lib/authApi";
import { AUTH_SESSION_INVALIDATED_EVENT } from "@/app/lib/authEvents";
import { setReportingUser } from "@/app/lib/errorReporting";
import { notifyError } from "@/app/lib/userFacingError";
import { clearToasts } from "@/shared/ui/ToastUI";

type User = AuthUser;

interface AuthContextType {
    user: User | null;
    isAuthenticated: boolean;
    authLoading: boolean;
    authError: string | null;
    signOut: () => Promise<void>;
    updateEmail: (email: string) => Promise<User>;
    setPassword: (password: string) => Promise<void>;
    refreshSession: () => Promise<User | null>;
    retrySession: () => Promise<User | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const AUTH_SYNC_CHANNEL = "mike-auth-state";
const AUTH_SYNC_STORAGE_KEY = "mike-auth-state-change";
const SESSION_ERROR_MESSAGE =
    "We could not check your session. Please try again.";
/** One toast for the session, however many background checks fail. */
const SESSION_TOAST_KEY = "auth-session";
const EXPIRED_SESSION_MESSAGE = "Your session expired. Please log in again.";

type AuthSyncMessage = {
    state: "signed-in" | "signed-out";
    nonce: string;
};

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);
    const [authError, setAuthError] = useState<string | null>(null);
    const channelRef = useRef<BroadcastChannel | null>(null);
    const sessionRequestRef = useRef<Promise<User | null> | null>(null);

    const broadcastAuthState = useCallback(
        (state: AuthSyncMessage["state"]) => {
            const message: AuthSyncMessage = {
                state,
                nonce:
                    typeof crypto.randomUUID === "function"
                        ? crypto.randomUUID()
                        : `${Date.now()}-${Math.random()}`,
            };
            channelRef.current?.postMessage(message);
            try {
                window.localStorage.setItem(
                    AUTH_SYNC_STORAGE_KEY,
                    JSON.stringify(message),
                );
            } catch {
                // Cross-tab sync is best-effort when storage is unavailable.
            }
        },
        [],
    );

    // Error reports carry the user id (never the email) so an issue can say
    // how many people it affects; cleared again on sign-out.
    useEffect(() => {
        setReportingUser(user ? { id: user.id } : null);
    }, [user]);

    const fetchAndApplySession = useCallback(async () => {
        if (!sessionRequestRef.current) {
            sessionRequestRef.current = getAuthSession().finally(() => {
                sessionRequestRef.current = null;
            });
        }
        const nextUser = await sessionRequestRef.current;
        setUser(nextUser);
        setAuthError(null);
        return nextUser;
    }, []);

    // Background session checks (focus, tab visibility, another tab signing
    // in) have no screen of their own: without this the user sees a silently
    // stale session, so the failure gets a toast with a real Retry.
    const reportSessionFailureRef = useRef<(error: unknown) => void>(() => {});
    const reportSessionFailure = useCallback(
        (error: unknown) => {
            setAuthError(SESSION_ERROR_MESSAGE);
            notifyError(error, {
                action: "check your session",
                dedupeKey: SESSION_TOAST_KEY,
                onRetry: () => {
                    void fetchAndApplySession().catch((retryError: unknown) =>
                        reportSessionFailureRef.current(retryError),
                    );
                },
            });
        },
        [fetchAndApplySession],
    );

    useEffect(() => {
        reportSessionFailureRef.current = reportSessionFailure;
    }, [reportSessionFailure]);

    useEffect(() => {
        clearLegacyBrowserAuthStorage();

        const channel =
            typeof BroadcastChannel === "undefined"
                ? null
                : new BroadcastChannel(AUTH_SYNC_CHANNEL);
        channelRef.current = channel;

        const applySyncMessage = (message: AuthSyncMessage) => {
            if (message.state === "signed-out") {
                setUser(null);
                setAuthError(null);
                setAuthLoading(false);
                // Signed out in another tab: same reasoning as above.
                clearToasts();
                return;
            }

            void fetchAndApplySession().catch(reportSessionFailure);
        };

        const onChannelMessage = (event: MessageEvent<AuthSyncMessage>) => {
            if (
                event.data?.state === "signed-in" ||
                event.data?.state === "signed-out"
            ) {
                applySyncMessage(event.data);
            }
        };
        const onStorage = (event: StorageEvent) => {
            if (event.key !== AUTH_SYNC_STORAGE_KEY || !event.newValue) return;
            try {
                const message = JSON.parse(event.newValue) as AuthSyncMessage;
                if (
                    message.state === "signed-in" ||
                    message.state === "signed-out"
                ) {
                    applySyncMessage(message);
                }
            } catch {
                // Ignore unrelated or malformed storage values.
            }
        };
        const onInvalidated = () => {
            setUser(null);
            setAuthError(EXPIRED_SESSION_MESSAGE);
            setAuthLoading(false);
            broadcastAuthState("signed-out");
        };
        const onVisibilityChange = () => {
            if (document.visibilityState !== "visible") return;
            void fetchAndApplySession().catch(reportSessionFailure);
        };
        const onFocus = () => {
            void fetchAndApplySession().catch(reportSessionFailure);
        };

        channel?.addEventListener("message", onChannelMessage);
        window.addEventListener("storage", onStorage);
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, onInvalidated);
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibilityChange);

        void fetchAndApplySession()
            .catch(reportSessionFailure)
            .finally(() => setAuthLoading(false));

        return () => {
            channel?.removeEventListener("message", onChannelMessage);
            channel?.close();
            channelRef.current = null;
            window.removeEventListener("storage", onStorage);
            window.removeEventListener(
                AUTH_SESSION_INVALIDATED_EVENT,
                onInvalidated,
            );
            window.removeEventListener("focus", onFocus);
            document.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
            );
        };
    }, [broadcastAuthState, fetchAndApplySession, reportSessionFailure]);

    const refreshSession = useCallback(async () => {
        try {
            const nextUser = await fetchAndApplySession();
            setAuthLoading(false);
            broadcastAuthState(nextUser ? "signed-in" : "signed-out");
            return nextUser;
        } catch (error) {
            setAuthError(SESSION_ERROR_MESSAGE);
            setAuthLoading(false);
            throw error;
        }
    }, [broadcastAuthState, fetchAndApplySession]);

    const signOut = useCallback(async () => {
        try {
            await logout("local");
            setUser(null);
            setAuthError(null);
            // Toasts outlive the screen that raised them. After a sign-out
            // the next screen is the login form, and "Couldn't save the
            // document — Retry" floating over it is both confusing and a
            // button that now acts as a different user.
            clearToasts();
            broadcastAuthState("signed-out");
        } catch (error) {
            setAuthError("Unable to sign out. Please try again.");
            throw error;
        }
    }, [broadcastAuthState]);

    const updateEmail = useCallback(async (email: string) => {
        const { user: nextUser } = await updateAuthEmail(
            email,
            "/settings?emailChange=processed",
        );
        setUser(nextUser);
        return nextUser;
    }, []);

    const setPassword = useCallback(async (password: string) => {
        const { user: nextUser } = await updateAuthPassword(password);
        setUser(nextUser);
    }, []);

    // A fresh object here re-renders every consumer of this context on every
    // provider render, sign-in state change or not. Each callback above is
    // itself memoized, so this only changes when user/authLoading/authError do.
    const value = useMemo<AuthContextType>(
        () => ({
            user,
            isAuthenticated: !!user,
            authLoading,
            authError,
            signOut,
            updateEmail,
            setPassword,
            refreshSession,
            retrySession: refreshSession,
        }),
        [
            user,
            authLoading,
            authError,
            signOut,
            updateEmail,
            setPassword,
            refreshSession,
        ],
    );

    return (
        <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
