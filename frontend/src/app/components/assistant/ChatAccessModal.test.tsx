import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "@/app/components/shared/types";
import { withIntl } from "@/test/withIntl";
import { ChatAccessModal } from "./ChatAccessModal";

const { getChatAccess, grantChatAccess, revokeChatAccess } = vi.hoisted(() => ({
    getChatAccess: vi.fn(),
    grantChatAccess: vi.fn(),
    revokeChatAccess: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { email: "me@example.com" } }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    getChatAccess: (...args: unknown[]) => getChatAccess(...args),
    getChatPeople: vi.fn(),
    grantChatAccess: (...args: unknown[]) => grantChatAccess(...args),
    revokeChatAccess: (...args: unknown[]) => revokeChatAccess(...args),
}));

vi.mock("@/app/components/modals/AccessModal", () => ({
    AccessModal: (props: {
        breadcrumb: string[];
        currentUserEmail?: string | null;
        access: {
            canManage: boolean;
            onGrant: (email: string, role: "editor") => Promise<void>;
            onRevoke: (email: string) => Promise<void>;
        };
    }) => (
        <div>
            <span>{props.breadcrumb.join(" / ")}</span>
            <span data-testid="current-email">{props.currentUserEmail}</span>
            <span data-testid="can-manage">
                {String(props.access.canManage)}
            </span>
            <button
                type="button"
                onClick={() =>
                    void props.access.onGrant("colleague@example.com", "editor")
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
    ),
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
            withIntl(<ChatAccessModal
                open
                chat={chat({ is_owner: true })}
                onClose={vi.fn()}
            />),
        );

        expect(screen.getByText("Assistente / Quarterly filing / Acesso")).toBeInTheDocument();
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

    it("offers the share field while the access request is still in flight", () => {
        getChatAccess.mockReturnValue(new Promise(() => {}));

        render(
            withIntl(<ChatAccessModal
                open
                chat={chat({ is_owner: true })}
                onClose={vi.fn()}
            />),
        );

        // Owners share from the moment the modal opens; the roster below is
        // what waits, not the Share Access label and input.
        expect(screen.getByTestId("can-manage")).toHaveTextContent("true");
    });

    it("keeps shared editors read-only without requesting owner-only data", () => {
        render(
            withIntl(<ChatAccessModal
                open
                chat={chat({ access_role: "editor" })}
                onClose={vi.fn()}
            />),
        );

        expect(screen.getByTestId("can-manage")).toHaveTextContent("false");
        expect(getChatAccess).not.toHaveBeenCalled();
    });
});
