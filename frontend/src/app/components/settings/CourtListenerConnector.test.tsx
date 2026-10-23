import type { ReactNode } from "react";
import {
    act,
    render,
    renderHook,
    screen,
    waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CourtListenerConnectorStatus } from "@/app/lib/mikeApi";
import {
    CourtListenerTokenModal,
    useCourtListenerConnector,
} from "./CourtListenerConnector";

const api = vi.hoisted(() => ({
    get: vi.fn(),
    setEnabled: vi.fn(),
    saveToken: vi.fn(),
    deleteToken: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    getCourtListenerConnector: api.get,
    setCourtListenerConnectorEnabled: api.setEnabled,
    saveCourtListenerConnectorToken: api.saveToken,
    deleteCourtListenerConnectorToken: api.deleteToken,
}));

// The key field has its own tests; here it shows whether an own token
// counts as saved, and hands its actions to the dialog.
vi.mock("./ApiKeyField", () => ({
    ApiKeyField: ({
        hasSavedKey,
        keyLabel,
        onSave,
        onRemove,
        render,
    }: {
        hasSavedKey: boolean;
        keyLabel: string;
        onSave: (value: string) => Promise<boolean>;
        onRemove: () => Promise<boolean>;
        render: (
            fields: ReactNode,
            saveAction: { label: string; onClick: () => Promise<void>; disabled: boolean },
            removeAction:
                | { label: string; onClick: () => Promise<void>; disabled: boolean }
                | undefined,
        ) => ReactNode;
    }) =>
        render(
            <div data-testid="courtlistener-key-state" data-key-label={keyLabel}>
                {hasSavedKey ? "own" : "none"}
            </div>,
            {
                label: "Save",
                onClick: async () => {
                    // The real field reports a thrown failure itself.
                    await onSave(" new-token ").catch(() => undefined);
                },
                disabled: false,
            },
            hasSavedKey
                ? {
                      label: "Remove",
                      onClick: async () => {
                          await onRemove().catch(() => undefined);
                      },
                      disabled: false,
                  }
                : undefined,
        ),
}));

function status(
    overrides: Partial<CourtListenerConnectorStatus> = {},
): CourtListenerConnectorStatus {
    return {
        enabled: true,
        installed: false,
        ownToken: false,
        tokenSource: null,
        bulkData: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue(status());
    api.setEnabled.mockImplementation(async (enabled: boolean) =>
        status({ installed: true, enabled }),
    );
    api.saveToken.mockResolvedValue(
        status({ installed: true, ownToken: true, tokenSource: "user" }),
    );
    api.deleteToken.mockResolvedValue(status());
});

describe("useCourtListenerConnector", () => {
    it("reads the status of the workspace it is given", async () => {
        api.get.mockResolvedValue(status({ installed: true, enabled: false }));
        const { result } = renderHook(() => useCourtListenerConnector("org-1"));
        expect(result.current.loading).toBe(true);
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(api.get).toHaveBeenCalledWith("org-1");
        expect(result.current).toMatchObject({ installed: true, enabled: false });
    });

    it("reads again when the workspace changes", async () => {
        const { result, rerender } = renderHook(
            ({ workspace }) => useCourtListenerConnector(workspace),
            { initialProps: { workspace: "personal" } },
        );
        await waitFor(() => expect(result.current.loading).toBe(false));
        rerender({ workspace: "org-2" });
        await waitFor(() => expect(api.get).toHaveBeenLastCalledWith("org-2"));
    });

    it("is not installed and stops loading when the status cannot be read", async () => {
        api.get.mockRejectedValue(new Error("down"));
        const { result } = renderHook(() => useCourtListenerConnector("personal"));
        await waitFor(() => expect(result.current.loadFailed).toBe(true));
        expect(result.current).toMatchObject({ loading: false, installed: false });
    });

    it("saves the switch in its workspace", async () => {
        api.get.mockResolvedValue(status({ installed: true }));
        const { result } = renderHook(() => useCourtListenerConnector("org-1"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(() => result.current.setEnabled(false));
        expect(api.setEnabled).toHaveBeenCalledWith(false, "org-1");
        expect(result.current.enabled).toBe(false);
    });

    it("puts the switch back and rethrows when it is not saved", async () => {
        api.get.mockResolvedValue(status({ installed: true }));
        const failure = new Error("nope");
        api.setEnabled.mockRejectedValue(failure);
        const { result } = renderHook(() => useCourtListenerConnector("personal"));
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => {
            await expect(result.current.setEnabled(false)).rejects.toBe(failure);
        });
        expect(result.current).toMatchObject({ enabled: true, busy: false });
    });
});

function Harness({
    workspace = "personal",
    organizationName = null,
    onClose,
    open = true,
}: {
    workspace?: string;
    organizationName?: string | null;
    onClose: () => void;
    open?: boolean;
}) {
    const connector = useCourtListenerConnector(workspace);
    if (connector.loading) return null;
    return (
        <CourtListenerTokenModal
            open={open}
            onClose={onClose}
            connector={connector}
            organizationName={organizationName}
        />
    );
}

async function renderModal(props: Parameters<typeof Harness>[0]) {
    render(<Harness {...props} />);
    if (props.open === false) {
        await waitFor(() => expect(api.get).toHaveBeenCalled());
        return;
    }
    await screen.findByTestId("courtlistener-key-state");
}

describe("CourtListenerTokenModal", () => {
    it("saves a trimmed token in its workspace and closes", async () => {
        const onClose = vi.fn();
        const user = userEvent.setup();
        await renderModal({ workspace: "org-1", onClose });

        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent("none");
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(api.saveToken).toHaveBeenCalledWith("new-token", "org-1");
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("stays open when the token is not saved", async () => {
        api.saveToken.mockRejectedValue(new Error("nope"));
        const onClose = vi.fn();
        const user = userEvent.setup();
        await renderModal({ onClose });

        await user.click(screen.getByRole("button", { name: "Save" }));
        expect(api.saveToken).toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("deletes the user's own token in its workspace", async () => {
        api.get.mockResolvedValue(
            status({ installed: true, ownToken: true, tokenSource: "user" }),
        );
        const onClose = vi.fn();
        const user = userEvent.setup();
        await renderModal({ workspace: "org-1", onClose });

        expect(screen.getByTestId("courtlistener-key-state")).toHaveTextContent("own");
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(api.deleteToken).toHaveBeenCalledWith("org-1");
        await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("says the organization provides a token and the user's own is optional", async () => {
        api.get.mockResolvedValue(status({ installed: true, tokenSource: "org" }));
        await renderModal({
            workspace: "org-1",
            organizationName: "Acme LLP",
            onClose: vi.fn(),
        });
        expect(
            screen.getByText(
                "Acme LLP provides a CourtListener token, so your own token is optional.",
            ),
        ).toBeTruthy();
        expect(screen.getByTestId("courtlistener-key-state")).toHaveAttribute(
            "data-key-label",
            "Your API token (optional)",
        );
        // Nothing of the user's own to delete.
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    });

    it("does not mention an organization's token when it has none", async () => {
        await renderModal({ onClose: vi.fn() });
        expect(screen.queryByText(/provides a CourtListener token/)).toBeNull();
    });

    it("notes the deployment's bulk data only when it is in use", async () => {
        await renderModal({ onClose: vi.fn() });
        expect(screen.queryByText("Bulk data installed and in use")).toBeNull();
    });

    it("notes the deployment's bulk data when it is in use", async () => {
        api.get.mockResolvedValue(status({ installed: true, bulkData: true }));
        await renderModal({ onClose: vi.fn() });
        expect(screen.getByText("Bulk data installed and in use")).toBeTruthy();
    });

    it("does not call the bulk data in use while CourtListener is off", async () => {
        api.get.mockResolvedValue(
            status({ installed: true, bulkData: true, enabled: false, ownToken: true }),
        );
        await renderModal({ onClose: vi.fn() });
        expect(screen.queryByText("Bulk data installed and in use")).toBeNull();
    });

    it("renders nothing while closed", async () => {
        await renderModal({ onClose: vi.fn(), open: false });
        expect(screen.queryByTestId("courtlistener-key-state")).toBeNull();
    });
});
