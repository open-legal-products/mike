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
    getOrgApiKeys: vi.fn(),
}));

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: mocks.userId ? { id: mocks.userId } : null }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    listOrgs: mocks.listOrgs,
    getOrgApiKeys: mocks.getOrgApiKeys,
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
    allow_personal_api_keys: true,
    can_manage: false,
});
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
