import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/app/components/shared/types";
import { MikeApiError } from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { ChatAccessModal } from "./ChatAccessModal";

const { getChatAccess, getChatPeople, grantChatAccess, revokeChatAccess } =
    vi.hoisted(() => ({
        getChatAccess: vi.fn(),
        getChatPeople: vi.fn(),
        grantChatAccess: vi.fn(),
        revokeChatAccess: vi.fn(),
    }));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { email: "me@example.com" } }),
}));

// importOriginal so MikeApiError stays the real class — userFacingApiError
// picks the server's own wording with an `instanceof` test.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getChatAccess: (...args: unknown[]) => getChatAccess(...args),
    getChatPeople: (...args: unknown[]) => getChatPeople(...args),
    grantChatAccess: (...args: unknown[]) => grantChatAccess(...args),
    revokeChatAccess: (...args: unknown[]) => revokeChatAccess(...args),
}));

// A faithful miniature of AccessModal: it CALLS fetchAccess and renders the
// rejection through userFacingApiError, exactly as the real one does. That
// call is the modal's error channel, and ChatAccessModal now routes the
// owner-only grants request through it — a stub that never called
// fetchAccess would test nothing about either.
vi.mock("@/app/components/modals/AccessModal", () => ({
    AccessModal: (props: {
        breadcrumb: string[];
        currentUserEmail?: string | null;
        resource: { id: string } | null;
        fetchAccess: (id: string) => Promise<unknown>;
        access: {
            canManage: boolean;
            onGrant: (email: string, role: "editor") => Promise<void>;
            onRevoke: (email: string) => Promise<void>;
        };
    }) => {
        const [error, setError] = useState<string | null>(null);
        const resourceId = props.resource?.id ?? null;
        const fetchAccess = props.fetchAccess;
        useEffect(() => {
            if (!resourceId) return;
            let cancelled = false;
            void fetchAccess(resourceId).catch((cause: unknown) => {
                if (!cancelled) {
                    setError(
                        userFacingApiError(
                            cause,
                            "Could not load access details.",
                        ),
                    );
                }
            });
            return () => {
                cancelled = true;
            };
        }, [fetchAccess, resourceId]);
        return (
            <div>
                <span>{props.breadcrumb.join(" / ")}</span>
                <span data-testid="current-email">{props.currentUserEmail}</span>
                <span data-testid="can-manage">
                    {String(props.access.canManage)}
                </span>
                <span data-testid="access-error">{error}</span>
                <button
                    type="button"
                    onClick={() =>
                        void props.access.onGrant(
                            "colleague@example.com",
                            "editor",
                        )
                    }
                >
                    Grant
                </button>
                <button
                    type="button"
                    onClick={() =>
                        void props.access.onRevoke("colleague@example.com")
                    }
                >
                    Revoke
                </button>
            </div>
        );
    },
}));

function chat(overrides: Partial<Chat> = {}): Chat {
    return {
        id: "chat-1",
        project_id: null,
        user_id: "user-1",
        title: "Quarterly filing",
        created_at: new Date().toISOString(),
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    getChatPeople.mockResolvedValue({ owner: null, members: [] });
    getChatAccess.mockResolvedValue({
        scope: "direct",
        org_id: null,
        access_role: "owner",
        grants: [],
    });
    grantChatAccess.mockResolvedValue(undefined);
    revokeChatAccess.mockResolvedValue(undefined);
});

describe("ChatAccessModal", () => {
    it("loads owner controls and updates chat grants", async () => {
        render(
            <ChatAccessModal
                open
                chat={chat({ is_owner: true })}
                onClose={vi.fn()}
            />,
        );

        expect(screen.getByText("Assistant / Quarterly filing / Access")).toBeInTheDocument();
        expect(screen.getByTestId("current-email")).toHaveTextContent(
            "me@example.com",
        );
        await waitFor(() =>
            expect(screen.getByTestId("can-manage")).toHaveTextContent("true"),
        );

        fireEvent.click(screen.getByRole("button", { name: "Grant" }));
        await waitFor(() =>
            expect(grantChatAccess).toHaveBeenCalledWith(
                "chat-1",
                "colleague@example.com",
                "editor",
            ),
        );
        expect(getChatAccess).toHaveBeenCalledTimes(2);
    });

    it("keeps shared editors read-only without requesting owner-only data", () => {
        render(
            <ChatAccessModal
                open
                chat={chat({ access_role: "editor" })}
                onClose={vi.fn()}
            />,
        );

        expect(screen.getByTestId("can-manage")).toHaveTextContent("false");
        expect(getChatAccess).not.toHaveBeenCalled();
    });

    it("tells an owner when the access load failed", async () => {
        // The failure used to land in a `.catch` that was a comment: `access`
        // stayed null, `canManage && access !== null` fell to false, and the
        // owner got a modal that was read-only for no stated reason —
        // indistinguishable from genuinely not being allowed to manage it.
        getChatAccess.mockRejectedValue(
            new MikeApiError({
                message: "Access details are unavailable",
                status: 409,
            }),
        );

        render(
            <ChatAccessModal
                open
                chat={chat({ is_owner: true })}
                onClose={vi.fn()}
            />,
        );

        await waitFor(() =>
            expect(screen.getByTestId("access-error")).toHaveTextContent(
                "Access details are unavailable",
            ),
        );
        // Still fail-closed: nothing may be granted from a modal that does
        // not know the current grants.
        expect(screen.getByTestId("can-manage")).toHaveTextContent("false");
    });

    it("falls back to generic wording for a non-4xx access failure", async () => {
        getChatAccess.mockRejectedValue(new Error("network"));

        render(
            <ChatAccessModal
                open
                chat={chat({ is_owner: true })}
                onClose={vi.fn()}
            />,
        );

        await waitFor(() =>
            expect(screen.getByTestId("access-error")).toHaveTextContent(
                "Could not load access details.",
            ),
        );
    });
});
