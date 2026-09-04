import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FeaturesPage from "./page";

const mocks = vi.hoisted(() => {
    class MikeApiError extends Error {
        status: number;
        code: string | null;

        constructor(args: { message: string; status: number; code?: string }) {
            super(args.message);
            this.status = args.status;
            this.code = args.code ?? null;
        }
    }

    return {
        MikeApiError,
        updateApiKey: vi.fn(),
        updateLegalResearchUs: vi.fn(),
        updateQuickActionsVisible: vi.fn(),
        listMcpConnectors: vi.fn(),
        createMcpConnector: vi.fn(),
        ensureLegalDataHunterConnector: vi.fn(),
        refreshMcpConnectorTools: vi.fn(),
        startMcpConnectorOAuth: vi.fn(),
        updateMcpConnector: vi.fn(),
        needsMfaVerification: vi.fn(),
        isMfaRequiredError: vi.fn(() => false),
    };
});

const profile = {
    legalResearchUs: true,
    quickActionsVisible: true,
    apiKeys: { courtlistener: { configured: false, source: null } },
};

vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile,
        updateApiKey: mocks.updateApiKey,
        updateLegalResearchUs: mocks.updateLegalResearchUs,
        updateQuickActionsVisible: mocks.updateQuickActionsVisible,
    }),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    MikeApiError: mocks.MikeApiError,
    listMcpConnectors: mocks.listMcpConnectors,
    createMcpConnector: mocks.createMcpConnector,
    ensureLegalDataHunterConnector: mocks.ensureLegalDataHunterConnector,
    refreshMcpConnectorTools: mocks.refreshMcpConnectorTools,
    startMcpConnectorOAuth: mocks.startMcpConnectorOAuth,
    updateMcpConnector: mocks.updateMcpConnector,
    isMfaRequiredError: mocks.isMfaRequiredError,
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    needsMfaVerification: mocks.needsMfaVerification,
    MfaVerificationPopup: ({
        open,
        onVerified,
    }: {
        open: boolean;
        onVerified: () => void;
    }) =>
        open ? <button onClick={onVerified}>Complete MFA</button> : null,
}));

const connector = {
    id: "ldh-connector",
    name: "Legal Data Hunter",
    transport: "streamable_http" as const,
    serverUrl: "https://legaldatahunter.com/mcp",
    authType: "oauth" as const,
    enabled: false,
    hasAuthConfig: false,
    customHeaderKeys: [],
    oauthConnected: false,
    toolPolicy: {},
    tools: [],
    toolCount: 0,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
};
const connectedConnector = {
    ...connector,
    enabled: true,
    oauthConnected: true,
    toolCount: 4,
};

describe("FeaturesPage Legal Data Hunter", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        vi.spyOn(window, "open").mockReturnValue({
            close: vi.fn(),
        } as unknown as Window);
        mocks.updateLegalResearchUs.mockResolvedValue(true);
        mocks.updateQuickActionsVisible.mockResolvedValue(true);
        mocks.listMcpConnectors.mockResolvedValue([]);
        mocks.needsMfaVerification.mockResolvedValue(false);
        mocks.createMcpConnector.mockResolvedValue(connector);
        mocks.ensureLegalDataHunterConnector.mockResolvedValue(connector);
        mocks.updateMcpConnector.mockImplementation(
            async (_id: string, update: { enabled?: boolean }) => ({
                ...connectedConnector,
                enabled: update.enabled ?? true,
            }),
        );
    });

    it("lists Legal Data Hunter beside CourtListener under Legal Research", async () => {
        render(<FeaturesPage />);

        expect(screen.getByText("Enable CourtListener")).toBeVisible();
        expect(screen.getByText("Enable Legal Data Hunter")).toBeVisible();
        expect(
            screen.getByRole("switch", { name: "Enable Legal Data Hunter" }),
        ).toBeVisible();
        expect(
            screen.getByText(
                "Legal Data Hunter provides access to global case law and legislation.",
            ),
        ).toBeVisible();
        await waitFor(() => expect(mocks.listMcpConnectors).toHaveBeenCalled());
    });

    it("creates and authorizes the built-in LDH connector when enabled", async () => {
        const user = userEvent.setup();
        mocks.refreshMcpConnectorTools
            .mockRejectedValueOnce(
                new mocks.MikeApiError({
                    message: "Authentication required",
                    status: 401,
                    code: "oauth_required",
                }),
            )
            .mockResolvedValueOnce(connectedConnector);
        mocks.startMcpConnectorOAuth.mockResolvedValue({
            authorizationUrl: null,
            alreadyAuthorized: true,
            callbackOrigin: window.location.origin,
        });
        render(<FeaturesPage />);

        await waitFor(() => expect(mocks.listMcpConnectors).toHaveBeenCalled());
        const legalResearchSwitches = screen.getAllByRole("switch");
        const legalDataHunterToggle = legalResearchSwitches.at(-1)!;
        expect(legalDataHunterToggle).toHaveAttribute("aria-checked", "false");

        await user.click(legalDataHunterToggle);

        await waitFor(() =>
            expect(mocks.ensureLegalDataHunterConnector).toHaveBeenCalledOnce(),
        );
        expect(mocks.createMcpConnector).not.toHaveBeenCalled();
        expect(mocks.startMcpConnectorOAuth).toHaveBeenCalledWith(
            connector.id,
        );
        expect(mocks.refreshMcpConnectorTools).toHaveBeenCalledTimes(2);
        await waitFor(() =>
            expect(legalDataHunterToggle).toHaveAttribute(
                "aria-checked",
                "true",
            ),
        );
    });

    it("disables every existing LDH connector without deleting any", async () => {
        const user = userEvent.setup();
        const duplicateConnector = {
            ...connectedConnector,
            id: "ldh-duplicate",
        };
        mocks.listMcpConnectors.mockResolvedValue([
            connectedConnector,
            duplicateConnector,
        ]);
        render(<FeaturesPage />);

        await waitFor(() =>
            expect(
                screen.getByRole("switch", {
                    name: "Enable Legal Data Hunter",
                }),
            ).toHaveAttribute("aria-checked", "true"),
        );
        await user.click(
            screen.getByRole("switch", { name: "Enable Legal Data Hunter" }),
        );

        await waitFor(() => {
            expect(mocks.updateMcpConnector).toHaveBeenCalledWith(
                connectedConnector.id,
                { enabled: false },
            );
            expect(mocks.updateMcpConnector).toHaveBeenCalledWith(
                duplicateConnector.id,
                { enabled: false },
            );
        });
        expect(mocks.createMcpConnector).not.toHaveBeenCalled();
    });

    it("rolls an enabled connector back off when OAuth startup fails", async () => {
        const user = userEvent.setup();
        mocks.ensureLegalDataHunterConnector.mockResolvedValue({
            ...connector,
            enabled: true,
        });
        mocks.refreshMcpConnectorTools.mockRejectedValue(
            new mocks.MikeApiError({
                message: "Authentication required",
                status: 401,
                code: "oauth_required",
            }),
        );
        mocks.startMcpConnectorOAuth.mockRejectedValue(
            new Error("OAuth popup failed"),
        );
        render(<FeaturesPage />);

        await waitFor(() => expect(mocks.listMcpConnectors).toHaveBeenCalled());
        await user.click(
            screen.getByRole("switch", { name: "Enable Legal Data Hunter" }),
        );

        await waitFor(() =>
            expect(mocks.updateMcpConnector).toHaveBeenCalledWith(connector.id, {
                enabled: false,
            }),
        );
        expect(
            screen.getByRole("switch", { name: "Enable Legal Data Hunter" }),
        ).toHaveAttribute("aria-checked", "false");
    });

    it("keeps the toggle disabled when connector inventory cannot be loaded", async () => {
        mocks.listMcpConnectors.mockRejectedValue(new Error("offline"));
        render(<FeaturesPage />);

        await waitFor(() =>
            expect(
                screen.getByRole("switch", {
                    name: "Enable Legal Data Hunter",
                }),
            ).toBeDisabled(),
        );
        expect(
            screen.getByText("Could not load the Legal Data Hunter setting."),
        ).toBeVisible();
    });

    it("completes required MFA before creating the connector", async () => {
        const user = userEvent.setup();
        mocks.needsMfaVerification
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        mocks.refreshMcpConnectorTools.mockResolvedValue(connectedConnector);
        render(<FeaturesPage />);

        await waitFor(() => expect(mocks.listMcpConnectors).toHaveBeenCalled());
        await user.click(screen.getAllByRole("switch").at(-1)!);

        expect(
            screen.getByRole("button", { name: "Complete MFA" }),
        ).toBeVisible();
        expect(mocks.ensureLegalDataHunterConnector).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Complete MFA" }),
        );
        await waitFor(() =>
            expect(mocks.ensureLegalDataHunterConnector).toHaveBeenCalled(),
        );
    });
});
