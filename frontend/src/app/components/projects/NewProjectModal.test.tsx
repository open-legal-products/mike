import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    MikeApiError,
    createProject,
    grantProjectAccess,
    listOrgs,
    lookupUserByEmail,
} from "@/app/lib/mikeApi";
import { NewProjectModal } from "./NewProjectModal";

// `importOriginal` keeps the real `MikeApiError`, which `userFacingApiError`
// recognises with `instanceof` — a stand-in would make the failure case pass
// for the wrong reason.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    createProject: vi.fn(),
    grantProjectAccess: vi.fn(),
    addDocumentToProject: vi.fn(),
    uploadProjectDocument: vi.fn(),
    listOrgs: vi.fn(),
    lookupUserByEmail: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("../shared/FileDirectory", () => ({ FileDirectory: () => null }));
vi.mock("./ProjectPracticeField", () => ({
    ProjectPracticeField: () => null,
}));

const CREATED = {
    id: "p1",
    name: "Matter",
    user_id: "me",
    cm_number: null,
    practice: null,
    shared_with: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
};

async function fillAndAdd(
    user: ReturnType<typeof userEvent.setup>,
    email: string,
    role: string,
) {
    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
    await user.selectOptions(
        screen.getByLabelText("Role for the new recipient"),
        role,
    );
    await user.type(screen.getByPlaceholderText("Add colleagues by email..."), email);
    await user.click(screen.getByRole("button", { name: "Add" }));
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await user.click(
        await screen.findByRole("button", { name: "Create project" }),
    );
}

function renderModal(onCreated = vi.fn()) {
    render(
        <NewProjectModal open onClose={vi.fn()} onCreated={onCreated} />,
    );
    return onCreated;
}

describe("NewProjectModal sharing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(listOrgs).mockResolvedValue([]);
        vi.mocked(createProject).mockResolvedValue(CREATED as never);
        vi.mocked(grantProjectAccess).mockResolvedValue({} as never);
    });

    it("shares with an address that has no Mike account, at the chosen role", async () => {
        // The create endpoint rejects unknown addresses with 400 "<email> does
        // not belong to a Mike user", and lands every address it does accept
        // at member. Both of those made the outside-counsel case — read-only,
        // no account yet — impossible to express at creation time.
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

        await fillAndAdd(user, "outside@counsel.test", "viewer");
        await submit(user);

        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "outside@counsel.test",
                "viewer",
            ),
        );
        // No account lookup: the address is validated for format only.
        expect(lookupUserByEmail).not.toHaveBeenCalled();
        expect(onCreated).toHaveBeenCalled();
    });

    it("hands the list a row that says the creator is its admin", async () => {
        // POST /projects returns a bare row with no role fields, and the
        // list's fail-closed roleFrom() reads that as viewer — so the
        // creator had no row menu, no Edit details and no Delete on the
        // project they just made until a refetch. The optimistic row must
        // say what the server will serve for it on every future load.
        const user = userEvent.setup();
        const onCreated = renderModal();
        await user.type(screen.getByPlaceholderText("Add project name"), "P");
        await submit(user);

        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(onCreated).toHaveBeenCalledWith(
            expect.objectContaining({ is_owner: true, access_role: "admin" }),
        );
    });

    it("never writes the roleless shared_with array", async () => {
        const user = userEvent.setup({ delay: null });
        renderModal();

        await fillAndAdd(user, "counsel@firm.test", "admin");
        await submit(user);

        await waitFor(() => expect(createProject).toHaveBeenCalled());
        // 4th argument is shared_with; sending it would flatten every role.
        expect(vi.mocked(createProject).mock.calls[0][3]).toBeUndefined();
        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "counsel@firm.test",
                "admin",
            ),
        );
    });

    it("gives each recipient their own role", { timeout: 15000 }, async () => {
        const user = userEvent.setup({ delay: null });
        renderModal();

        await fillAndAdd(user, "one@firm.test", "admin");
        await user.selectOptions(
            screen.getByLabelText("Role for the new recipient"),
            "viewer",
        );
        await user.type(
            screen.getByPlaceholderText("Add colleagues by email..."),
            "two@firm.test",
        );
        await user.click(screen.getByRole("button", { name: "Add" }));

        // Each row carries its own picker, and changing one leaves the other.
        await user.selectOptions(
            screen.getByLabelText("Role for one@firm.test"),
            "member",
        );
        expect(
            (screen.getByLabelText("Role for two@firm.test") as HTMLSelectElement)
                .value,
        ).toBe("viewer");

        await submit(user);

        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "one@firm.test",
                "member",
            ),
        );
        expect(grantProjectAccess).toHaveBeenCalledWith(
            "p1",
            "two@firm.test",
            "viewer",
        );
    });

    it("reports a refused grant and does not create a second project on retry", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();
        vi.mocked(grantProjectAccess).mockRejectedValueOnce(
            new MikeApiError({
                status: 400,
                message: "The project creator already has admin access",
            }),
        );

        await fillAndAdd(user, "counsel@firm.test", "member");
        await submit(user);

        expect(
            await screen.findByText(
                /Project created, but access was not granted to counsel@firm.test: The project creator already has admin access/,
            ),
        ).toBeInTheDocument();
        // The dialog stays open on the only screen that knows sharing failed.
        expect(onCreated).not.toHaveBeenCalled();

        // Retry: the project already exists, so it must not be created twice.
        await user.click(screen.getByRole("button", { name: "Create project" }));
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(createProject).toHaveBeenCalledTimes(1);
        expect(grantProjectAccess).toHaveBeenCalledTimes(2);
    });

    it("offers exactly Admin, Member and Viewer", async () => {
        renderModal();
        const select = await screen.findByLabelText(
            "Role for the new recipient",
        );
        expect(
            within(select).getAllByRole("option").map((o) => o.textContent),
        ).toEqual(["Admin", "Member", "Viewer"]);
        expect((select as HTMLSelectElement).value).toBe("member");
    });
});
