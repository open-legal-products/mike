import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import {
    DocumentWorkspaceScope,
    PERSONAL_WORKSPACE,
    WorkspaceProvider,
    useDocumentWorkspace,
    useWorkspace,
    useWorkspaceOrgId,
    useWorkspaceParam,
} from "./WorkspaceContext";

const mocks = vi.hoisted(() => ({
    userId: "u1" as string | null,
    listOrgs: vi.fn(),
    updateOrgPreferences: vi.fn(),
    getOrgApiKeys: vi.fn(),
    getOrgPreferences: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    listOrgs: mocks.listOrgs,
    getOrgApiKeys: mocks.getOrgApiKeys,
    getOrgPreferences: mocks.getOrgPreferences,
    updateOrgPreferences: mocks.updateOrgPreferences,
}));

const ACME = { id: "org-acme", name: "Acme LLP", role: "member" };
const BETA = { id: "org-beta", name: "Beta Chambers", role: "owner" };
const STORAGE_KEY = "mike.activeWorkspace.u1";

// The context value as of the last commit, so a test can call its actions.
// Published from an effect: render must not write to module state.
let latest: ReturnType<typeof useWorkspace>;
function Probe() {
    const value = useWorkspace();
    useEffect(() => {
        latest = value;
    });
    const param = useWorkspaceParam();
    return (
        <p>
            {value.workspaceId}|{param ?? "unscoped"}|
            {value.organizations === null ? "loading" : "loaded"}|
            {value.activeOrganization?.name ?? "none"}
        </p>
    );
}

function OrgIdProbe() {
    return <p>org:{useWorkspaceOrgId() ?? "none"}</p>;
}

// What the server says an organization's work can run on, tagged with the
// organization so a test can tell whose answer is on screen.
const keysFor = (orgId: string) => ({
    keys: {},
    effective: { marker: orgId },
    can_manage: false,
});
// The tabular model stands in for the whole answer, naming whose it is.
const preferencesFor = (orgId: string) => ({ tabular_model: orgId });
const shownPreferences = () => latest.orgPreferences?.tabular_model ?? null;
const shownKeys = () =>
    (latest.orgApiKeys?.effective as { marker?: string } | undefined)?.marker ??
    null;

function renderProvider(child: ReactNode = <Probe />) {
    return render(<WorkspaceProvider>{child}</WorkspaceProvider>);
}

beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.userId = "u1";
    mocks.listOrgs.mockResolvedValue([ACME, BETA]);
    mocks.getOrgApiKeys.mockImplementation(async (orgId: string) =>
        keysFor(orgId),
    );
    mocks.getOrgPreferences.mockImplementation(async (orgId: string) =>
        preferencesFor(orgId),
    );
});

describe("WorkspaceProvider", () => {
    it("starts in the personal workspace", async () => {
        renderProvider();
        expect(screen.getByText(/^personal\|personal\|loading/)).toBeInTheDocument();
        await screen.findByText("personal|personal|loaded|none");
    });

    it("names no organization for work started in Personal", async () => {
        renderProvider(<OrgIdProbe />);
        expect(await screen.findByText("org:none")).toBeInTheDocument();
    });

    it("names the active organization for work started in its workspace, before the organizations load", async () => {
        // Waiting for the list would file something started in that moment
        // under Personal. The server checks membership.
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider(<OrgIdProbe />);
        expect(screen.getByText(`org:${ACME.id}`)).toBeInTheDocument();
    });

    it("stops naming an organization the caller turns out to have left", async () => {
        window.localStorage.setItem(STORAGE_KEY, "org-gone");
        renderProvider(<OrgIdProbe />);
        expect(await screen.findByText("org:none")).toBeInTheDocument();
    });

    it("restores the workspace this account last used, before the organizations load", async () => {
        // Asking for Personal first and the organization a moment later would
        // paint the wrong workspace's lists on every reload.
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        expect(
            screen.getByText(`${ACME.id}|${ACME.id}|loading|none`),
        ).toBeInTheDocument();
        await screen.findByText(`${ACME.id}|${ACME.id}|loaded|Acme LLP`);
    });

    it("falls back to Personal when the remembered organization is gone", async () => {
        window.localStorage.setItem(STORAGE_KEY, "org-left");
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");
        await waitFor(() =>
            expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
                PERSONAL_WORKSPACE,
            ),
        );
    });

    it("keeps the remembered organization when the organizations cannot be read", async () => {
        // A failed read is not evidence that the person left their firm.
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        mocks.listOrgs.mockRejectedValue(new Error("network"));
        renderProvider();
        await waitFor(() => expect(mocks.listOrgs).toHaveBeenCalled());
        expect(
            screen.getByText(`${ACME.id}|${ACME.id}|loading|none`),
        ).toBeInTheDocument();
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(ACME.id);
    });

    it("switches workspace and remembers the choice for this account", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");

        act(() => latest.setWorkspace(BETA.id));
        await screen.findByText(`${BETA.id}|${BETA.id}|loaded|Beta Chambers`);
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(BETA.id);

        act(() => latest.setWorkspace(PERSONAL_WORKSPACE));
        await screen.findByText("personal|personal|loaded|none");
        expect(window.localStorage.getItem(STORAGE_KEY)).toBe(
            PERSONAL_WORKSPACE,
        );
    });

    it("ignores a workspace the caller does not belong to", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");
        act(() => latest.setWorkspace("org-stranger"));
        // It asks once, in case the organization is new to them...
        await waitFor(() => expect(mocks.listOrgs).toHaveBeenCalledTimes(2));
        // ...and, since it is not theirs, goes nowhere.
        expect(
            screen.getByText("personal|personal|loaded|none"),
        ).toBeInTheDocument();
    });

    it("switches to an organization joined or created since the list was read", async () => {
        // The Organizations page lists a brand-new organization from its own
        // read and offers Switch at once. The click must not be dropped just
        // because this provider has not heard of it yet.
        const GAMMA = { id: "org-gamma", name: "Gamma & Co", role: "owner" };
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");

        mocks.listOrgs.mockResolvedValue([ACME, BETA, GAMMA]);
        act(() => latest.setWorkspace(GAMMA.id));

        await screen.findByText(`${GAMMA.id}|${GAMMA.id}|loaded|Gamma & Co`);
        await waitFor(() => expect(window.localStorage.getItem(STORAGE_KEY)).toBe(GAMMA.id));
    });

    it("switches even before the organizations have first loaded", async () => {
        let arrive: (value: unknown) => void = () => {};
        mocks.listOrgs.mockImplementationOnce(
            () => new Promise((resolve) => (arrive = resolve)),
        );
        renderProvider();
        expect(screen.getByText(/\|loading\|/)).toBeInTheDocument();

        act(() => latest.setWorkspace(BETA.id));
        await screen.findByText(`${BETA.id}|${BETA.id}|loaded|Beta Chambers`);
        await act(async () => arrive([ACME, BETA]));
        expect(
            screen.getByText(`${BETA.id}|${BETA.id}|loaded|Beta Chambers`),
        ).toBeInTheDocument();
    });

    it("stays put when the organizations cannot be read to check", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");

        mocks.listOrgs.mockRejectedValue(new Error("network"));
        act(() => latest.setWorkspace("org-new"));
        await waitFor(() => expect(mocks.listOrgs).toHaveBeenCalledTimes(2));

        expect(
            screen.getByText("personal|personal|loaded|none"),
        ).toBeInTheDocument();
    });

    it("moves to Personal when a refresh shows the active organization was left", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await screen.findByText(`${ACME.id}|${ACME.id}|loaded|Acme LLP`);

        mocks.listOrgs.mockResolvedValue([BETA]);
        await act(() => latest.refreshOrganizations());
        await screen.findByText("personal|personal|loaded|none");

        // Being invited back later must not silently move them again.
        mocks.listOrgs.mockResolvedValue([ACME, BETA]);
        await act(() => latest.refreshOrganizations());
        expect(
            screen.getByText("personal|personal|loaded|none"),
        ).toBeInTheDocument();
    });

    it("re-reads the organizations when the tab becomes visible again", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");
        expect(mocks.listOrgs).toHaveBeenCalledTimes(1);

        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await waitFor(() => expect(mocks.listOrgs).toHaveBeenCalledTimes(2));
    });

    it("keeps each account's remembered workspace separate", async () => {
        window.localStorage.setItem("mike.activeWorkspace.u2", BETA.id);
        mocks.userId = "u2";
        renderProvider();
        await screen.findByText(`${BETA.id}|${BETA.id}|loaded|Beta Chambers`);
        expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
});

describe("the active organization's model provider keys", () => {
    it("are not read in the personal workspace", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");
        expect(mocks.getOrgApiKeys).not.toHaveBeenCalled();
        expect(latest.orgApiKeys).toBeNull();
    });

    it("are read for the organization the caller is working in", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownKeys()).toBe(ACME.id));
        expect(mocks.getOrgApiKeys).toHaveBeenCalledExactlyOnceWith(ACME.id);
    });

    it("never show one organization's keys under another's name", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownKeys()).toBe(ACME.id));

        // The next organization's answer is slow to arrive.
        let arrive: (value: unknown) => void = () => {};
        mocks.getOrgApiKeys.mockImplementation(
            () => new Promise((resolve) => (arrive = resolve)),
        );
        act(() => latest.setWorkspace(BETA.id));
        await screen.findByText(`${BETA.id}|${BETA.id}|loaded|Beta Chambers`);
        // Unknown while it loads — not Acme's.
        expect(latest.orgApiKeys).toBeNull();

        await act(async () => arrive(keysFor(BETA.id)));
        await waitFor(() => expect(shownKeys()).toBe(BETA.id));
    });

    it("are dropped on returning to the personal workspace", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownKeys()).toBe(ACME.id));

        act(() => latest.setWorkspace(PERSONAL_WORKSPACE));
        await screen.findByText("personal|personal|loaded|none");
        expect(latest.orgApiKeys).toBeNull();
    });

    it("are re-read on request, after they were changed in settings", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownKeys()).toBe(ACME.id));

        mocks.getOrgApiKeys.mockResolvedValue({
            ...keysFor(ACME.id),
            effective: { marker: "changed" },
        });
        await act(() => latest.refreshOrgApiKeys());
        expect(shownKeys()).toBe("changed");
    });

    it("stay unknown when they cannot be read, and keep the last answer on a failed re-read", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        mocks.getOrgApiKeys.mockRejectedValueOnce(new Error("network"));
        renderProvider();
        await screen.findByText(`${ACME.id}|${ACME.id}|loaded|Acme LLP`);
        await waitFor(() => expect(mocks.getOrgApiKeys).toHaveBeenCalled());
        expect(latest.orgApiKeys).toBeNull();

        await act(() => latest.refreshOrgApiKeys());
        expect(shownKeys()).toBe(ACME.id);

        mocks.getOrgApiKeys.mockRejectedValueOnce(new Error("network"));
        await act(() => latest.refreshOrgApiKeys());
        expect(shownKeys()).toBe(ACME.id);
    });
});

describe("the active organization's preferences", () => {
    it("are not read in the personal workspace", async () => {
        renderProvider();
        await screen.findByText("personal|personal|loaded|none");
        expect(mocks.getOrgPreferences).not.toHaveBeenCalled();
        expect(latest.orgPreferences).toBeNull();
    });

    it("are read for the organization the caller is working in", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));
        expect(mocks.getOrgPreferences).toHaveBeenCalledExactlyOnceWith(
            ACME.id,
            expect.any(AbortSignal),
        );
    });

    it("never show one organization's preferences under another's name", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        let arrive: (value: unknown) => void = () => {};
        mocks.getOrgPreferences.mockImplementation(
            () => new Promise((resolve) => (arrive = resolve)),
        );
        act(() => latest.setWorkspace(BETA.id));
        await screen.findByText(`${BETA.id}|${BETA.id}|loaded|Beta Chambers`);
        expect(latest.orgPreferences).toBeNull();

        await act(async () => arrive(preferencesFor(BETA.id)));
        await waitFor(() => expect(shownPreferences()).toBe(BETA.id));
    });

    it("are dropped on returning to the personal workspace", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        act(() => latest.setWorkspace(PERSONAL_WORKSPACE));
        await screen.findByText("personal|personal|loaded|none");
        expect(latest.orgPreferences).toBeNull();
    });

    it("take a saved answer in place, for the organization it was saved for only", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        mocks.updateOrgPreferences.mockResolvedValueOnce({
            ...preferencesFor(ACME.id),
            tabular_model: "saved",
        });
        await act(() =>
            latest.saveOrgPreferences(ACME.id, { tabular_model: "saved" }),
        );
        expect(mocks.updateOrgPreferences).toHaveBeenCalledWith(ACME.id, {
            tabular_model: "saved",
        });
        expect(shownPreferences()).toBe("saved");

        // A save that lands after switching away is not shown as Beta's.
        act(() => latest.setWorkspace(BETA.id));
        await waitFor(() => expect(shownPreferences()).toBe(BETA.id));
        mocks.updateOrgPreferences.mockResolvedValueOnce(preferencesFor("late"));
        await act(() =>
            latest.saveOrgPreferences(ACME.id, { tabular_model: "late" }),
        );
        expect(shownPreferences()).toBe(BETA.id);
    });

    it("keep a saved answer over a read that started before the save", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        let arrive: (value: unknown) => void = () => {};
        mocks.getOrgPreferences.mockImplementationOnce(
            () => new Promise((resolve) => (arrive = resolve)),
        );
        let stale: Promise<unknown> = Promise.resolve();
        act(() => {
            stale = latest.loadOrgPreferences(ACME.id);
        });
        mocks.updateOrgPreferences.mockResolvedValueOnce(preferencesFor("saved"));
        await act(() =>
            latest.saveOrgPreferences(ACME.id, { tabular_model: "saved" }),
        );
        await act(async () => {
            arrive(preferencesFor("stale"));
            await stale;
        });
        expect(shownPreferences()).toBe("saved");

        // A read that starts after the save applies as usual.
        mocks.getOrgPreferences.mockResolvedValueOnce(preferencesFor("fresh"));
        await act(() => latest.loadOrgPreferences(ACME.id));
        expect(shownPreferences()).toBe("fresh");
    });

    it("keeps a save over a stale visibility refresh started during the save", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        const patch = Promise.withResolvers<unknown>();
        const read = Promise.withResolvers<unknown>();
        mocks.updateOrgPreferences.mockReturnValueOnce(patch.promise);
        mocks.getOrgPreferences.mockReturnValueOnce(read.promise);
        const saving = latest.saveOrgPreferences(ACME.id, { tabular_model: "new" });
        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await act(async () => {
            patch.resolve(preferencesFor("new"));
            await saving;
        });
        await act(async () => read.resolve(preferencesFor("old")));
        expect(shownPreferences()).toBe("new");
    });

    it("saves overlapping edits in order and publishes both changes", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        const first = Promise.withResolvers<unknown>();
        mocks.updateOrgPreferences
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce({ tabular_model: "new", quick_actions_visible: false });
        const toggle = latest.saveOrgPreferences(ACME.id, { quick_actions_visible: false });
        const model = latest.saveOrgPreferences(ACME.id, { tabular_model: "new" });
        expect(mocks.updateOrgPreferences).toHaveBeenCalledTimes(1);
        await act(async () => {
            first.resolve({ tabular_model: "old", quick_actions_visible: false });
            await Promise.all([toggle, model]);
        });
        expect(latest.orgPreferences).toMatchObject({
            tabular_model: "new",
            quick_actions_visible: false,
        });
    });

    it("continues a queued edit after an earlier save fails", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        const first = Promise.withResolvers<unknown>();
        mocks.updateOrgPreferences
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce(preferencesFor("new"));
        const toggle = latest.saveOrgPreferences(ACME.id, { quick_actions_visible: false });
        const model = latest.saveOrgPreferences(ACME.id, { tabular_model: "new" });
        await act(async () => {
            first.reject(new Error("network"));
            await expect(toggle).rejects.toThrow("network");
            await model;
        });
        expect(shownPreferences()).toBe("new");
    });

    it("keeps a new organization's load when a save is retried for the old one", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        const read = Promise.withResolvers<unknown>();
        mocks.getOrgPreferences.mockReturnValueOnce(read.promise);
        act(() => latest.setWorkspace(BETA.id));
        await waitFor(() => expect(mocks.getOrgPreferences).toHaveBeenCalledWith(
            BETA.id, expect.any(AbortSignal),
        ));
        mocks.updateOrgPreferences.mockResolvedValueOnce(preferencesFor("retry"));
        await act(() => latest.saveOrgPreferences(ACME.id, { tabular_model: "retry" }));
        await act(async () => read.resolve(preferencesFor(BETA.id)));
        expect(shownPreferences()).toBe(BETA.id);
    });

    it("takes the new organization's settings-page read and save after its own read failed", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        // Acme stays cached while the provider's read of Beta fails.
        mocks.getOrgPreferences.mockRejectedValueOnce(new Error("network"));
        act(() => latest.setWorkspace(BETA.id));
        await waitFor(() => expect(mocks.getOrgPreferences).toHaveBeenCalledWith(
            BETA.id, expect.any(AbortSignal),
        ));
        await waitFor(() => expect(latest.orgPreferences).toBeNull());

        // The settings page's own read of Beta succeeds and is shown...
        mocks.getOrgPreferences.mockResolvedValueOnce(preferencesFor(BETA.id));
        await act(() => latest.loadOrgPreferences(BETA.id));
        expect(shownPreferences()).toBe(BETA.id);

        // ...and so is a save to Beta.
        mocks.updateOrgPreferences.mockResolvedValueOnce(preferencesFor("beta-saved"));
        await act(() => latest.saveOrgPreferences(BETA.id, { tabular_model: "beta-saved" }));
        expect(shownPreferences()).toBe("beta-saved");
    });

    it("keeps a newer read when an older read of the same organization answers last", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        const older = Promise.withResolvers<unknown>();
        const newer = Promise.withResolvers<unknown>();
        mocks.getOrgPreferences
            .mockReturnValueOnce(older.promise)
            .mockReturnValueOnce(newer.promise);
        let olderRead: Promise<unknown> = Promise.resolve();
        let newerRead: Promise<unknown> = Promise.resolve();
        act(() => {
            olderRead = latest.loadOrgPreferences(ACME.id);
            newerRead = latest.loadOrgPreferences(ACME.id);
        });
        await act(async () => {
            newer.resolve(preferencesFor("newer"));
            await newerRead;
        });
        await act(async () => {
            older.resolve(preferencesFor("older"));
            await olderRead;
        });
        expect(shownPreferences()).toBe("newer");
    });

    it("still takes an older read when the newer read of the organization fails", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        const older = Promise.withResolvers<unknown>();
        mocks.getOrgPreferences
            .mockReturnValueOnce(older.promise)
            .mockRejectedValueOnce(new Error("network"));
        let olderRead: Promise<unknown> = Promise.resolve();
        let newerRead: Promise<unknown> = Promise.resolve();
        act(() => {
            olderRead = latest.loadOrgPreferences(ACME.id);
            newerRead = latest.loadOrgPreferences(ACME.id).catch(() => undefined);
        });
        await act(async () => {
            await newerRead;
            older.resolve(preferencesFor("older"));
            await olderRead;
        });
        expect(shownPreferences()).toBe("older");
    });

    it("drops queued writes when the account session ends", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        const view = renderProvider();
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));

        const first = Promise.withResolvers<unknown>();
        mocks.updateOrgPreferences.mockReturnValueOnce(first.promise);
        const toggle = latest.saveOrgPreferences(ACME.id, { quick_actions_visible: false });
        const model = latest.saveOrgPreferences(ACME.id, { tabular_model: "new" });
        view.unmount();
        first.resolve(preferencesFor("old"));
        await expect(model).rejects.toMatchObject({ name: "AbortError" });
        await toggle;
        expect(mocks.updateOrgPreferences).toHaveBeenCalledTimes(1);
    });

    it("stay unknown when they cannot be read, and are read again on returning to the tab", async () => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        mocks.getOrgPreferences.mockRejectedValueOnce(new Error("network"));
        renderProvider();
        await screen.findByText(`${ACME.id}|${ACME.id}|loaded|Acme LLP`);
        await waitFor(() => expect(mocks.getOrgPreferences).toHaveBeenCalled());
        expect(latest.orgPreferences).toBeNull();

        act(() => {
            document.dispatchEvent(new Event("visibilitychange"));
        });
        await waitFor(() => expect(shownPreferences()).toBe(ACME.id));
    });
});

describe("a failed read of the organizations", () => {
    it("is reported while nothing is known, and cleared once a read succeeds", async () => {
        mocks.listOrgs.mockRejectedValueOnce(new Error("network"));
        renderProvider();
        await waitFor(() => expect(latest.organizationsFailed).toBe(true));
        expect(latest.organizations).toBeNull();

        await act(() => latest.refreshOrganizations());
        expect(latest.organizationsFailed).toBe(false);
        expect(latest.organizations).toEqual([ACME, BETA]);
    });

    it("is not reported over organizations already known", async () => {
        renderProvider();
        await waitFor(() => expect(latest.organizations).not.toBeNull());
        mocks.listOrgs.mockRejectedValueOnce(new Error("network"));
        await act(() => latest.refreshOrganizations());
        expect(latest.organizationsFailed).toBe(false);
    });
});

describe("outside a provider, preferences", () => {
    it("cannot be read or saved", async () => {
        render(<Probe />);
        await expect(latest.loadOrgPreferences("o")).rejects.toThrow();
        await expect(latest.saveOrgPreferences("o", {})).rejects.toThrow();
    });
});

describe("outside a WorkspaceProvider", () => {
    it("does not narrow lists at all", () => {
        // Surfaces that render without the app shell keep listing everything,
        // as they did before workspaces existed.
        render(<Probe />);
        expect(screen.getByText("|unscoped|loading|none")).toBeInTheDocument();
    });
});

// Pickers and uploads inside a chat, review, project or workflow use that
// item's workspace: it takes documents from nowhere else, whichever
// workspace happens to be active.
describe("the workspace documents are offered from", () => {
    function DocumentProbe() {
        return <p>documents:{useDocumentWorkspace() ?? "unscoped"}</p>;
    }
    const inAcme = (children: ReactNode) => {
        window.localStorage.setItem(STORAGE_KEY, ACME.id);
        return render(<WorkspaceProvider>{children}</WorkspaceProvider>);
    };

    it("is the active workspace where nothing says otherwise", async () => {
        inAcme(<DocumentProbe />);
        expect(
            await screen.findByText(`documents:${ACME.id}`),
        ).toBeInTheDocument();
    });

    it("is the organization of the item on screen, not the active one", async () => {
        inAcme(
            <DocumentWorkspaceScope orgId={BETA.id}>
                <DocumentProbe />
            </DocumentWorkspaceScope>,
        );
        expect(
            await screen.findByText(`documents:${BETA.id}`),
        ).toBeInTheDocument();
    });

    it("is Personal for a personal item opened while an organization is active", async () => {
        inAcme(
            <DocumentWorkspaceScope orgId={null}>
                <DocumentProbe />
            </DocumentWorkspaceScope>,
        );
        expect(
            await screen.findByText(`documents:${PERSONAL_WORKSPACE}`),
        ).toBeInTheDocument();
    });

    it("stays with what is already known while the item is still loading", async () => {
        // A chat inside a project says nothing of its own; the project does.
        inAcme(
            <DocumentWorkspaceScope orgId={BETA.id}>
                <DocumentWorkspaceScope orgId={undefined}>
                    <DocumentProbe />
                </DocumentWorkspaceScope>
            </DocumentWorkspaceScope>,
        );
        expect(
            await screen.findByText(`documents:${BETA.id}`),
        ).toBeInTheDocument();
    });

    it("is not narrowed outside the app shell", () => {
        render(<DocumentProbe />);
        expect(screen.getByText("documents:unscoped")).toBeInTheDocument();
    });
});
