import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
    getEffectiveApiKeyStatus: vi.fn(),
    getUserApiKeyStatus: vi.fn(),
    loadCourtListenerConnection: vi.fn(),
    saveCourtListenerConnection: vi.fn(),
}));
vi.mock("../../../lib/providerCredentials/index", () => store);

import {
    courtListenerConnectorStatus,
    setCourtListenerEnabled,
    setCourtListenerToken,
} from "../user.courtlistener";

const db = {} as never;
const personal = { userId: "u1", orgId: null };
const inFirm = { userId: "u1", orgId: "org-1" };

const keyStatus = (source: "user" | "org" | null) => ({
    courtlistener: source !== null,
    sources: { courtlistener: source },
});

beforeEach(() => {
    vi.clearAllMocks();
    store.loadCourtListenerConnection.mockResolvedValue({ enabled: true, token: null });
    store.getUserApiKeyStatus.mockResolvedValue(keyStatus(null));
    store.getEffectiveApiKeyStatus.mockResolvedValue(keyStatus(null));
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("CourtListener connector status", () => {
    it("reads Personal from the person's own keys", async () => {
        store.loadCourtListenerConnection.mockResolvedValue({ enabled: false, token: "t" });
        store.getUserApiKeyStatus.mockResolvedValue(keyStatus("user"));

        expect(await courtListenerConnectorStatus(db, personal)).toEqual({
            enabled: false,
            installed: true,
            ownToken: true,
            tokenSource: "user",
            bulkData: false,
        });
        expect(store.loadCourtListenerConnection).toHaveBeenCalledWith(personal, db);
        expect(store.getEffectiveApiKeyStatus).not.toHaveBeenCalled();
    });

    it("reads an organization through its keys, which may be the organization's own", async () => {
        store.getEffectiveApiKeyStatus.mockResolvedValue(keyStatus("org"));

        expect(await courtListenerConnectorStatus(db, inFirm)).toMatchObject({
            installed: true,
            ownToken: false,
            tokenSource: "org",
        });
        expect(store.getEffectiveApiKeyStatus).toHaveBeenCalledWith("u1", "org-1", db);
    });

    it("is installed by the bulk index alone", async () => {
        vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "true");
        expect(await courtListenerConnectorStatus(db, inFirm)).toMatchObject({
            installed: true,
            tokenSource: null,
            bulkData: true,
        });
    });

    it("goes back to Discover when switched off with nothing of the user's saved", async () => {
        vi.stubEnv("COURTLISTENER_BULK_DATA_ENABLED", "true");
        store.loadCourtListenerConnection.mockResolvedValue({ enabled: false, token: null });
        expect(await courtListenerConnectorStatus(db, personal)).toMatchObject({
            enabled: false,
            installed: false,
            bulkData: true,
        });

        vi.unstubAllEnvs();
        store.getEffectiveApiKeyStatus.mockResolvedValue(keyStatus("org"));
        expect(await courtListenerConnectorStatus(db, inFirm)).toMatchObject({
            enabled: false,
            installed: false,
            tokenSource: "org",
        });
    });

    it("stays installed while switched off when the user saved a token here", async () => {
        store.loadCourtListenerConnection.mockResolvedValue({ enabled: false, token: "t" });
        // Even where the organization keeps personal tokens out of play.
        store.getEffectiveApiKeyStatus.mockResolvedValue(keyStatus(null));
        expect(await courtListenerConnectorStatus(db, inFirm)).toMatchObject({
            installed: true,
            ownToken: true,
            tokenSource: null,
        });
    });

    it("is not installed when switched on with nothing to answer lookups", async () => {
        expect(await courtListenerConnectorStatus(db, personal)).toMatchObject({
            enabled: true,
            installed: false,
        });
    });
});

describe("CourtListener connector changes", () => {
    it("saves the switch for the workspace", async () => {
        await setCourtListenerEnabled(db, inFirm, false);
        expect(store.saveCourtListenerConnection).toHaveBeenCalledWith(
            inFirm,
            { enabled: false },
            db,
        );
    });

    it("turns the connector on when a token is saved, and leaves the switch when one is removed", async () => {
        await setCourtListenerToken(db, inFirm, "  token  ");
        expect(store.saveCourtListenerConnection).toHaveBeenLastCalledWith(
            inFirm,
            { token: "token", enabled: true },
            db,
        );
        await setCourtListenerToken(db, inFirm, null);
        expect(store.saveCourtListenerConnection).toHaveBeenLastCalledWith(
            inFirm,
            { token: null },
            db,
        );
    });
});
