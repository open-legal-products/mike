"use client";

import {
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
import { isOnAuthRoute, notifyError } from "@/app/lib/userFacingError";
import { clearToasts } from "@mike/ui";

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
/** Retry delays for a session check the server could not answer. */
const SESSION_RETRY_BASE_MS = 1_000;
const SESSION_RETRY_MAX_MS = 30_000;

/**
 * Did the session check fail because the server could not answer (a 5xx such
 * as 503 upstream_unavailable while GoTrue or the API is down, or no response
 * at all), rather than answer "no session"? Then nobody knows whether the
 * user is signed in, and treating them as signed out would send a working
 * session to the login page. A 401 never gets here: getAuthSession answers
 * null for it.
 */
function isTransientSessionFailure(error: unknown): boolean {
    // An AuthApiError carries the HTTP status (read by shape, so a test that
    // mocks the auth client needs no class).
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number") return status >= 500;
    // fetch rejects with a TypeError when no response arrives.
    return error instanceof TypeError;
}

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

    const sessionUserIdRef = useRef<string | null>(null);
    const applySessionUser = useCallback((nextUser: User | null) => {
        // Notifications can hold write closures from the previous account.
        // Every session-ending or identity-changing path must discard them.
        if (!nextUser || sessionUserIdRef.current !== nextUser.id) clearToasts();
        sessionUserIdRef.current = nextUser?.id ?? null;
        setUser(nextUser);
    }, []);

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
        applySessionUser(nextUser);
        setAuthError(null);
        return nextUser;
    }, [applySessionUser]);

    // Background session checks (focus, tab visibility, another tab signing
    // in) have no screen of their own: without this the user sees a silently
    // stale session, so the failure gets a toast with a real Retry.
    const checkSessionRef = useRef<(notify: boolean) => Promise<void>>(
        async () => {},
    );
    const reportSessionFailure = useCallback((error: unknown) => {
        setAuthError(SESSION_ERROR_MESSAGE);
        // Sign-in screens show `authError` themselves, with their own
        // Retry; a toast there repeated it and then contradicted the
        // form's next error.
        if (isOnAuthRoute()) return;
        notifyError(error, {
            action: "check your session",
            dedupeKey: SESSION_TOAST_KEY,
            onRetry: () => void checkSessionRef.current(true),
        });
    }, []);

    // A check the server could not answer keeps the auth state it had (the
    // signed-in user, or "still loading" on a fresh page load, which keeps
    // the app's loader up instead of redirecting to the login page) and is
    // retried with backoff until the server answers. One notice per failing
    // streak: the retries update it silently.
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const retryAttemptRef = useRef(0);
    const checkSession = useCallback(
        async (notify: boolean) => {
            if (retryTimerRef.current !== null) {
                clearTimeout(retryTimerRef.current);
                retryTimerRef.current = null;
            }
            try {
                await fetchAndApplySession();
                retryAttemptRef.current = 0;
                setAuthLoading(false);
            } catch (error) {
                const firstOfStreak = retryAttemptRef.current === 0;
                if (isTransientSessionFailure(error)) {
                    const delay = Math.min(
                        SESSION_RETRY_MAX_MS,
                        SESSION_RETRY_BASE_MS * 2 ** retryAttemptRef.current,
                    );
                    retryAttemptRef.current += 1;
                    retryTimerRef.current = setTimeout(() => {
                        retryTimerRef.current = null;
                        void checkSessionRef.current(false);
                    }, delay);
                } else {
                    retryAttemptRef.current = 0;
                    setAuthLoading(false);
                }
                if (notify || firstOfStreak) reportSessionFailure(error);
                else setAuthError(SESSION_ERROR_MESSAGE);
            }
        },
        [fetchAndApplySession, reportSessionFailure],
    );

    useEffect(() => {
        checkSessionRef.current = checkSession;
    }, [checkSession]);

    useEffect(
        () => () => {
            if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
        },
        [],
    );

    useEffect(() => {
        clearLegacyBrowserAuthStorage();

        const channel =
            typeof BroadcastChannel === "undefined"
                ? null
                : new BroadcastChannel(AUTH_SYNC_CHANNEL);
        channelRef.current = channel;

        const applySyncMessage = (message: AuthSyncMessage) => {
            if (message.state === "signed-out") {
                applySessionUser(null);
                setAuthError(null);
                setAuthLoading(false);
                return;
            }

            void checkSession(true);
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
            applySessionUser(null);
            setAuthError(EXPIRED_SESSION_MESSAGE);
            setAuthLoading(false);
            broadcastAuthState("signed-out");
        };
        const onVisibilityChange = () => {
            if (document.visibilityState !== "visible") return;
            void checkSession(false);
        };
        const onFocus = () => {
            void checkSession(false);
        };

        channel?.addEventListener("message", onChannelMessage);
        window.addEventListener("storage", onStorage);
        window.addEventListener(AUTH_SESSION_INVALIDATED_EVENT, onInvalidated);
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisibilityChange);

        // Through the ref (assigned by the effect above, which runs first):
        // the check only sets state after its request settles.
        void checkSessionRef.current(true);

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
    }, [applySessionUser, broadcastAuthState, checkSession]);

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
            applySessionUser(null);
            setAuthError(null);
            broadcastAuthState("signed-out");
        } catch (error) {
            setAuthError("Unable to sign out. Please try again.");
            throw error;
        }
    }, [applySessionUser, broadcastAuthState]);

    const updateEmail = useCallback(async (email: string) => {
        const { user: nextUser } = await updateAuthEmail(
            email,
            "/settings?emailChange=processed",
        );
        applySessionUser(nextUser);
        return nextUser;
    }, [applySessionUser]);

    const setPassword = useCallback(async (password: string) => {
        const { user: nextUser } = await updateAuthPassword(password);
        applySessionUser(nextUser);
    }, [applySessionUser]);

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

export function useOptionalAuth() {
    return useContext(AuthContext);
}

export function useAuth() {
    const context = useOptionalAuth();
    if (context === undefined) {
        throw new Error("useAuth must be used within an AuthProvider");
    }
    return context;
}
