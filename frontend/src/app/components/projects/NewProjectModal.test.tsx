import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    MikeApiError,
    createProject,
    grantProjectAccess,
    listOrgMembers,
    lookupUserByEmail,
  setProjectMemoryEnabled,
  updateProject,
  uploadProjectDocuments,
} from "@/app/lib/mikeApi";
import { NewProjectModal } from "./NewProjectModal";

const { useUserProfile, activeWorkspace } = vi.hoisted(() => ({
    useUserProfile: vi.fn(),
    // `null` is "no workspace provider": the modal behaves as it always has.
    activeWorkspace: { id: null as string | null, name: "Acme LLP" },
}));

vi.mock("@/app/contexts/WorkspaceContext", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("@/app/contexts/WorkspaceContext")
    >()),
    useWorkspace: () => ({
        workspaceId: activeWorkspace.id,
        organizations: null,
        activeOrganization:
            activeWorkspace.id && activeWorkspace.id !== "personal"
                ? {
                      id: activeWorkspace.id,
                      name: activeWorkspace.name,
                      role: "member",
                  }
                : null,
        setWorkspace: vi.fn(),
        refreshOrganizations: vi.fn(),
    }),
}));

// `importOriginal` keeps the real `MikeApiError`, which `userFacingApiError`
// recognises with `instanceof` — a stand-in would make the failure case pass
// for the wrong reason.
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    createProject: vi.fn(),
    grantProjectAccess: vi.fn(),
    addDocumentToProject: vi.fn(),
    uploadProjectDocument: vi.fn(),
    uploadProjectDocuments: vi.fn(),
    listOrgMembers: vi.fn(),
    updateProject: vi.fn(),
    lookupUserByEmail: vi.fn(),
    setProjectMemoryEnabled: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "me", email: "me@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile,
}));
vi.mock("../shared/FileDirectory", () => ({ FileDirectory: () => null }));
vi.mock("./ProjectPracticeField", () => ({
    ProjectPracticeField: ({
        id,
        value,
        disabled,
    }: {
        id: string;
        value: string;
        disabled?: boolean;
    }) => (
        <button id={id} type="button" disabled={disabled}>
            {value || "None"}
        </button>
    ),
}));

const CREATED = {
    id: "p1",
    name: "Matter",
    user_id: "me",
    cm_number: null,
    practice: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  memory_enabled: true,
};

async function fillAndAdd(
    user: ReturnType<typeof userEvent.setup>,
    email: string,
    role: string,
) {
    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
    expect(
        screen.queryByPlaceholderText("Add by email..."),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next" }));
    if (role !== "editor") {
        await user.click(
            screen.getByRole("button", { name: /Role for the new recipient/ }),
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: role[0].toUpperCase() + role.slice(1),
            }),
        );
    }
    await user.type(screen.getByPlaceholderText("Add by email..."), email);
    await user.click(screen.getByRole("button", { name: "Add" }));
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
    if (!screen.queryByRole("button", { name: "Create project" })) {
        const detailsNext = screen.getByRole("button", { name: "Next" });
        await waitFor(() => expect(detailsNext).toBeEnabled());
        await user.click(detailsNext);
    }
    if (!screen.queryByRole("button", { name: "Create project" })) {
        await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible(),
        );
        expect(screen.getByText("Share Access")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Next" }));
    }
    await user.click(
        await screen.findByRole("button", { name: "Create project" }),
    );
}

function renderModal(onCreated = vi.fn()) {
    render(<NewProjectModal open onClose={vi.fn()} onCreated={onCreated} />);
    return onCreated;
}

describe("NewProjectModal sharing", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        activeWorkspace.id = null;
        activeWorkspace.name = "Acme LLP";
        vi.mocked(listOrgMembers).mockResolvedValue([]);
        vi.mocked(createProject).mockResolvedValue(CREATED as never);
        vi.mocked(grantProjectAccess).mockResolvedValue({} as never);
    vi.mocked(setProjectMemoryEnabled).mockResolvedValue({
      enabled: false,
      content: "",
      revision: 1,
      hash: null,
      updated_at: null,
      updated_by: null,
      source: "settings",
      status: "idle",
    });
    vi.mocked(uploadProjectDocuments).mockResolvedValue([]);
        vi.mocked(lookupUserByEmail).mockImplementation(async (email) => ({
            exists: true,
            email,
            display_name: "Existing user",
        }));
        useUserProfile.mockReturnValue({
            profile: { practiceAreas: [], projectMemoryDefault: true },
        });
    });

    it("starts with the user's first preset practice area", async () => {
        useUserProfile.mockReturnValue({
            profile: {
                practiceAreas: ["Corporate and M&A", "Litigation"],
                projectMemoryDefault: true,
            },
        });
        renderModal();

        expect(await screen.findByLabelText("Practice")).toHaveTextContent(
            "Corporate and M&A",
        );
    });

  it("creates a new project in the active workspace's organization, private unless made public", async () => {
    activeWorkspace.id = "org-1";
    const user = userEvent.setup({ delay: null });
    renderModal();

    // No choosing a workspace here: it is the one being worked in.
    expect(
      screen.queryByLabelText("Share across Organisation"),
    ).not.toBeInTheDocument();
    // Access: Private by default, Public as the other pill.
    const access = screen.getByRole("group", { name: "Organisational Access" });
    expect(
      within(access).getByRole("button", { name: "Private" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(access).getByRole("button", { name: "Public" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText(
        "Only the people you share this project with can open it.",
      ),
    ).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Add project name"), "P");
    while (!screen.queryByRole("button", { name: "Create project" })) {
      const next = screen.getByRole("button", { name: "Next" });
      await waitFor(() => expect(next).toBeEnabled());
      await user.click(next);
    }
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        "org-1",
        true,
        "private",
      ),
    );
  });

  it("offers no Public toggle for a personal project", () => {
    activeWorkspace.id = "personal";
    renderModal();
    expect(
      screen.queryByRole("group", { name: "Organisational Access" }),
    ).not.toBeInTheDocument();
  });

  it("starts a new project as personal in the personal workspace", async () => {
    activeWorkspace.id = "personal";
    const user = userEvent.setup({ delay: null });
    renderModal();

    await user.type(screen.getByPlaceholderText("Add project name"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
  });

  it("labels project memory once, and reads On or Off beside the switch", async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();

    expect(screen.getByText("Project memory")).toBeInTheDocument();
    // The label says what it is; no second line explaining it.
    expect(
      screen.queryByText("Let Mike remember shared project context"),
    ).not.toBeInTheDocument();

    const memory = screen.getByRole("switch", { name: "Enable project memory" });
    expect(memory).toHaveTextContent("On");
    await user.click(memory);
    expect(memory).toHaveTextContent("Off");
    expect(memory).toHaveAttribute("aria-checked", "false");
  });

  it("creates new projects with memory enabled by default", async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();

    expect(
      screen.getByRole("switch", { name: "Enable project memory" }),
    ).toBeChecked();
    await user.type(screen.getByPlaceholderText("Add project name"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
  });

  it("follows the account's off default for new projects", async () => {
    useUserProfile.mockReturnValue({
      profile: { practiceAreas: [], projectMemoryDefault: false },
    });
    const user = userEvent.setup({ delay: null });
    renderModal();

    expect(
      screen.getByRole("switch", { name: "Enable project memory" }),
    ).not.toBeChecked();
    await user.type(screen.getByPlaceholderText("Add project name"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        false,
      ),
    );
  });

  it("lets the creator override the account default for one project", async () => {
    useUserProfile.mockReturnValue({
      profile: { practiceAreas: [], projectMemoryDefault: false },
    });
    const user = userEvent.setup({ delay: null });
    renderModal();

    await user.click(
      screen.getByRole("switch", { name: "Enable project memory" }),
    );
    await user.type(screen.getByPlaceholderText("Add project name"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
  });

  it("resets to the account default, not to on, after a project is created", async () => {
    // resetForm hard-coded `true`, so the next project started from this
    // still-open modal silently opted into project memory against the
    // account's saved default.
    useUserProfile.mockReturnValue({
      profile: { practiceAreas: [], projectMemoryDefault: false },
    });
    const user = userEvent.setup({ delay: null });
    renderModal();

    await user.type(screen.getByPlaceholderText("Add project name"), "P");
    await submit(user);
    await waitFor(() => expect(createProject).toHaveBeenCalled());

    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Enable project memory" }),
      ).not.toBeChecked(),
    );
  });

  it("honours an explicit project-memory opt-out", async () => {
    const user = userEvent.setup({ delay: null });
    renderModal();

    await user.click(
      screen.getByRole("switch", { name: "Enable project memory" }),
    );
    await user.type(screen.getByPlaceholderText("Add project name"), "P");
    await submit(user);

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith(
        "P",
        undefined,
        undefined,
        undefined,
        false,
      ),
    );
  });

    it("shares with an existing user at the chosen role", async () => {
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
        expect(lookupUserByEmail).toHaveBeenCalledWith("outside@counsel.test");
        expect(onCreated).toHaveBeenCalled();
    });

    it("does not add an email that has no Mike account", async () => {
        vi.mocked(lookupUserByEmail).mockResolvedValueOnce({
            exists: false,
            email: "future@firm.test",
            display_name: null,
        });
        const user = userEvent.setup({ delay: null });
        renderModal();

        await fillAndAdd(user, "future@firm.test", "viewer");

        expect(
            await screen.findByText(
                "future@firm.test does not belong to a Mike user.",
            ),
        ).toBeInTheDocument();
        expect(grantProjectAccess).not.toHaveBeenCalled();
        expect(
            screen.queryByRole("button", { name: "Role for future@firm.test" }),
        ).not.toBeInTheDocument();
    });

    it("hands the list a row that says the creator is its owner", async () => {
        // POST /projects returns a bare row with no role fields, and the
        // list's fail-closed roleFrom() reads that as viewer — so the
        // creator had no row menu, no Edit details and no Delete on the
        // project they just made until a refetch. The optimistic row must
        // say what the server will serve for it on every future load.
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();
        await user.type(screen.getByPlaceholderText("Add project name"), "P");
        await submit(user);

        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(onCreated).toHaveBeenCalledWith(
            expect.objectContaining({
                is_owner: true,
                access_role: "owner",
                access_scope: "private",
            }),
        );
    });

    it("does not create or redirect until document selection is finished", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("dialog", { name: "Access" })).toBeVisible();
        expect(createProject).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const accessNext = screen.getByRole("button", { name: "Next" });
        expect(accessNext).toHaveAttribute("type", "button");
        await user.click(accessNext);
    expect(screen.getByRole("dialog", { name: "Add Documents" })).toBeVisible();
        expect(createProject).not.toHaveBeenCalled();
        expect(onCreated).not.toHaveBeenCalled();

        const form = document.getElementById("new-project-modal-form");
        expect(form).not.toBeNull();
        fireEvent.submit(form!);
        expect(createProject).not.toHaveBeenCalled();

        const create = screen.getByRole("button", { name: "Create project" });
        expect(create).toHaveAttribute("type", "button");
        await user.click(create);
        await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
        expect(onCreated).toHaveBeenCalled();
    });

    it("creates grants through the role-aware endpoint", async () => {
        const user = userEvent.setup({ delay: null });
        const onCreated = renderModal();

        await fillAndAdd(user, "counsel@firm.test", "owner");
        await submit(user);

        await waitFor(() => expect(createProject).toHaveBeenCalled());
        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "counsel@firm.test",
                "owner",
            ),
        );
        expect(onCreated).toHaveBeenCalledWith(
            expect.objectContaining({
                access_scope: "shared",
                direct_grant_count: 1,
            }),
        );
    });

    it("gives each recipient their own role", { timeout: 15000 }, async () => {
        const user = userEvent.setup({ delay: null });
        renderModal();

        await fillAndAdd(user, "one@firm.test", "owner");
        await user.click(
            screen.getByRole("button", { name: /Role for the new recipient/ }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Viewer" }));
        await user.type(
            screen.getByPlaceholderText("Add by email..."),
            "two@firm.test",
        );
        await user.click(screen.getByRole("button", { name: "Add" }));

        // Each row carries its own picker, and changing one leaves the other.
        await user.click(
            screen.getByRole("button", { name: "Role for one@firm.test" }),
        );
        await user.click(screen.getByRole("menuitem", { name: "Editor" }));
        expect(
            screen.getByRole("button", { name: "Role for two@firm.test" }),
        ).toHaveTextContent("Viewer");

        await submit(user);

        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "one@firm.test",
                "editor",
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
                message: "The project creator already has owner access",
            }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await submit(user);

        expect(
            await screen.findByText(
                /Project created, but access was not granted to counsel@firm.test: The project creator already has owner access/,
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

  it("persists a changed memory opt-out before retrying a created project", async () => {
    const user = userEvent.setup({ delay: null });
    const onCreated = renderModal();
    vi.mocked(grantProjectAccess).mockRejectedValueOnce(
      new MikeApiError({
        status: 400,
        message: "Sharing failed",
      }),
    );

    await fillAndAdd(user, "counsel@firm.test", "editor");
    await submit(user);
    await screen.findByText(/Project created, but access was not granted/);

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(
      screen.getByRole("switch", { name: "Enable project memory" }),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("p1", false),
    );
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ memory_enabled: false }),
    );
  });

  it("persists a changed memory opt-out before continuing after a partial upload", async () => {
    const user = userEvent.setup({ delay: null });
    const onCreated = renderModal();
    // Echo the client ids the modal sends: completed uploads are tracked by
    // the id each File went out under, so an outcome with an invented id
    // would read as a file that never landed.
    vi.mocked(uploadProjectDocuments).mockImplementation(async (_id, inputs) =>
      inputs.map((input) =>
        input.file.name === "saved.pdf"
          ? {
              clientId: input.clientId ?? "one",
              filename: "saved.pdf",
              status: "completed" as const,
              result: { id: "doc-1", filename: "saved.pdf" } as never,
              errorCode: null,
            }
          : {
              clientId: input.clientId ?? "two",
              filename: "failed.pdf",
              status: "error" as const,
              result: null,
              errorCode: "processing_failed",
            },
      ),
    );

    await user.type(screen.getByPlaceholderText("Add project name"), "P");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["saved"], "saved.pdf"),
          new File(["failed"], "failed.pdf"),
        ],
      },
    });
    await submit(user);
    await screen.findByRole("button", { name: "Continue" });

    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await user.click(
      screen.getByRole("switch", { name: "Enable project memory" }),
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(setProjectMemoryEnabled).toHaveBeenCalledWith("p1", false),
    );
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ memory_enabled: false }),
    );
  });

    it("shows direct sharing only on step two with Owner, Editor and Viewer", async () => {
        const user = userEvent.setup({ delay: null });
        renderModal();
    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
        expect(
            screen.queryByPlaceholderText("Add by email..."),
        ).not.toBeInTheDocument();
        const next = screen.getByRole("button", { name: "Next" });
        await waitFor(() => expect(next).toBeEnabled());
        await user.click(next);
        const skip = screen.getByRole("button", { name: "Skip" });
        const accessNext = screen.getByRole("button", { name: "Next" });
        expect(skip.parentElement).toBe(accessNext.parentElement);
        expect(skip).toHaveClass("text-gray-500");
        expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
            "bg-blue-600/90",
        );
        const trigger = await screen.findByRole("button", {
            name: /Role for the new recipient/,
        });
        expect(trigger).toHaveTextContent("Editor");
        await user.click(trigger);
        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent),
        ).toEqual(["Owner", "Editor", "Viewer"]);
    });

    const ORG_MEMBERS = [
        {
            user_id: "me",
            email: "me@firm.test",
            display_name: "Project Creator",
            role: "member",
            created_at: "2026-01-01T00:00:00Z",
        },
        {
            user_id: "member-lead",
            email: "lead@elite.test",
            display_name: "Project Lead",
            role: "member",
            created_at: "2026-01-01T00:00:00Z",
        },
        {
            user_id: "member-denied",
            email: "blocked@elite.test",
            display_name: "Blocked Member",
            role: "member",
            created_at: "2026-01-01T00:00:00Z",
        },
        {
            user_id: "org-admin",
            email: "admin@elite.test",
            display_name: "Organization Admin",
            role: "admin",
            created_at: "2026-01-01T00:00:00Z",
        },
        {
            user_id: "org-owner",
            email: "owner@elite.test",
            display_name: "Organization Owner",
            role: "owner",
            created_at: "2026-01-01T00:00:00Z",
        },
    ];

    it("shares a private organization project with individual members", async () => {
        const user = userEvent.setup({ delay: null });
        activeWorkspace.id = "org-1";
        activeWorkspace.name = "Elite Law LLP";
        vi.mocked(listOrgMembers).mockResolvedValue(ORG_MEMBERS as never);
        renderModal();
    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
        // Left private on the details step.
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(
            screen.getByRole("dialog", { name: "People" }),
        ).toBeVisible();
        // The setting was made on the details step, not here.
        expect(
            screen.queryByRole("group", { name: "Organisational Access" }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Deny list" }),
        ).not.toBeInTheDocument();

        const peoplePicker = await screen.findByRole("searchbox", {
            name: "People",
        });
        // Neither the organization's owner nor an admin can open a private
        // project unless it is shared with them, so both are offered.
        await user.type(peoplePicker, "Organization");
        expect(
            await screen.findByRole("option", { name: /Organization Admin/ }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("option", { name: /Organization Owner/ }),
        ).toBeInTheDocument();
        await user.clear(peoplePicker);

        await user.type(peoplePicker, "lead");
        await user.click(
            await screen.findByRole("option", { name: /Project Lead/ }),
        );
        const people = screen.getByRole("list", { name: "People with access" });
        expect(within(people).getByText("Project Lead")).toBeInTheDocument();
        expect(within(people).getByText("Project Creator")).toBeInTheDocument();
        expect(within(people).getByText("lead@elite.test")).toHaveClass(
            "sm:justify-self-end",
        );
        expect(
            within(people).queryByRole("button", {
                name: "Actions for me@firm.test",
            }),
        ).not.toBeInTheDocument();
        expect(people.parentElement).toHaveClass(
            "min-h-28", "max-h-72", "overflow-y-auto",
        );

        await submit(user);
        await waitFor(() =>
            expect(createProject).toHaveBeenCalledWith(
                "Matter",
                undefined,
                undefined,
                "org-1",
                true,
                "private",
            ),
        );
        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "lead@elite.test",
                "editor",
            ),
        );
    });

    it("makes an organization project public from its details, and walls a member off", async () => {
        const user = userEvent.setup({ delay: null });
        activeWorkspace.id = "org-1";
        activeWorkspace.name = "Elite Law LLP";
        vi.mocked(listOrgMembers).mockResolvedValue(ORG_MEMBERS as never);
        renderModal();
    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
        const publicToggle = screen.getByRole("button", { name: "Public" });
        await user.click(publicToggle);
        expect(publicToggle).toHaveAttribute("aria-pressed", "true");
        expect(
            screen.getByText(
                "Everyone in Elite Law LLP can open and edit this project.",
            ),
        ).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(
            screen.getByRole("dialog", { name: "People" }),
        ).toBeVisible();
        // Everybody can already open and edit it, so what is offered is
        // adding owners — not a general people picker.
        expect(
            screen.queryByRole("searchbox", { name: "People" }),
        ).not.toBeInTheDocument();
        const ownerPicker = await screen.findByRole("searchbox", {
            name: "Project owners",
        });
        await user.type(ownerPicker, "lead");
        await user.click(
            await screen.findByRole("option", { name: /Project Lead/ }),
        );
        const owners = screen.getByRole("list", { name: "Project owners list" });
        expect(within(owners).getByText("Project Lead")).toBeInTheDocument();
    expect(within(owners).getByText("Project Creator")).toBeInTheDocument();

        await user.click(
            await screen.findByRole("button", { name: "Deny list" }),
        );
        const denyPicker = screen.getByRole("searchbox", { name: "Deny list" });
        await user.type(denyPicker, "blocked");
        await user.click(
            await screen.findByRole("option", { name: /Blocked Member/ }),
        );
        const denyList = screen.getByRole("list", { name: "Deny list entries" });
    expect(within(denyList).getByText("Blocked Member")).toBeInTheDocument();

        await submit(user);
        await waitFor(() =>
            expect(createProject).toHaveBeenCalledWith(
                "Matter",
                undefined,
                undefined,
                "org-1",
                true,
                "organization",
            ),
        );
        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledWith(
                "p1",
                "blocked@elite.test",
                "deny",
            ),
        );
        expect(grantProjectAccess).toHaveBeenCalledWith(
            "p1",
            "lead@elite.test",
            "owner",
        );
        expect(grantProjectAccess).toHaveBeenCalledTimes(2);
    });

    it("drops the people lined up for a private project when it is made public", async () => {
        // Named people belong to a private project. Carried into a public
        // one they would be applied where nothing on screen shows them.
        const user = userEvent.setup({ delay: null });
        activeWorkspace.id = "org-1";
        activeWorkspace.name = "Elite Law LLP";
        vi.mocked(listOrgMembers).mockResolvedValue(ORG_MEMBERS as never);
        renderModal();
    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
        await user.click(screen.getByRole("button", { name: "Next" }));
        const peoplePicker = await screen.findByRole("searchbox", {
            name: "People",
        });
        await user.type(peoplePicker, "lead");
        await user.click(
            await screen.findByRole("option", { name: /Project Lead/ }),
        );

        await user.click(screen.getByRole("button", { name: "Back" }));
        await user.click(screen.getByRole("button", { name: "Public" }));
        while (!screen.queryByRole("button", { name: "Create project" })) {
            await user.click(screen.getByRole("button", { name: "Next" }));
        }
        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );

        await waitFor(() => expect(createProject).toHaveBeenCalled());
        expect(grantProjectAccess).not.toHaveBeenCalled();
    });

    it("applies a changed Public setting to a project that already exists on retry", async () => {
        // A refused grant leaves the created project in place. Going Back
        // and changing who can open it must reach that project, which the
        // retry reuses rather than creating again.
        const user = userEvent.setup({ delay: null });
        activeWorkspace.id = "org-1";
        activeWorkspace.name = "Elite Law LLP";
        vi.mocked(listOrgMembers).mockResolvedValue(ORG_MEMBERS as never);
        vi.mocked(updateProject).mockResolvedValue({} as never);
        vi.mocked(grantProjectAccess).mockRejectedValueOnce(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );
        renderModal();
    await user.type(screen.getByPlaceholderText("Add project name"), "Matter");
        await user.click(screen.getByRole("button", { name: "Next" }));
        const peoplePicker = await screen.findByRole("searchbox", {
            name: "People",
        });
        await user.type(peoplePicker, "lead");
        await user.click(
            await screen.findByRole("option", { name: /Project Lead/ }),
        );
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );
        await screen.findByText(/Project created, but access was not granted/);
        // Created private; nothing to re-save on the first attempt.
        expect(updateProject).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Back" }));
        await user.click(screen.getByRole("button", { name: "Back" }));
        await user.click(screen.getByRole("button", { name: "Public" }));
        while (!screen.queryByRole("button", { name: "Create project" })) {
            await user.click(screen.getByRole("button", { name: "Next" }));
        }
        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );

        await waitFor(() =>
            expect(updateProject).toHaveBeenCalledWith("p1", {
                visibility: "organization",
            }),
        );
        expect(createProject).toHaveBeenCalledTimes(1);
    });

    async function attachPendingFile(filename: string) {
        const fileInput = document.querySelector(
            'input[type="file"]',
        ) as HTMLInputElement;
        expect(fileInput).not.toBeNull();
        fireEvent.change(fileInput, {
            target: { files: [new File(["contents"], filename)] },
        });
        await screen.findByRole("button", { name: /Upload \(1\)/ });
    }

    it("uploads an attached file once when a refused grant is retried", async () => {
        // The grant refusal used to return with the pending files still
        // queued, so the retry — which correctly skipped creation — re-ran the
        // upload and the project ended up with the same document twice.
        const user = userEvent.setup({ delay: null });
        const onCreated = vi.fn();
        render(
            <NewProjectModal open onClose={vi.fn()} onCreated={onCreated} />,
        );
        vi.mocked(grantProjectAccess).mockRejectedValueOnce(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );
        vi.mocked(uploadProjectDocuments).mockResolvedValue([
            {
                clientId: "c1",
                filename: "brief.pdf",
                status: "completed",
                result: null,
                errorCode: null,
            },
        ]);

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await attachPendingFile("brief.pdf");

        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );
        expect(
            await screen.findByText(
                /Project created, but access was not granted to counsel@firm\.test/,
            ),
        ).toBeInTheDocument();
        // Grants run first, so a refusal leaves no upload to redo.
        expect(uploadProjectDocuments).not.toHaveBeenCalled();

        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );
        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(createProject).toHaveBeenCalledTimes(1);
        expect(uploadProjectDocuments).toHaveBeenCalledTimes(1);
    });

    it("tells the caller to refetch when a created project is never handed over", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        const onCreated = vi.fn();
        render(<NewProjectModal open onClose={onClose} onCreated={onCreated} />);
        vi.mocked(grantProjectAccess).mockRejectedValue(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await submit(user);
        await screen.findByText(/Project created, but access was not granted/);

        await user.click(screen.getByRole("button", { name: "Close" }));
        expect(onCreated).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledWith(true);
    });

    it("cannot be dismissed while the project is being created", async () => {
        const user = userEvent.setup({ delay: null });
        const onClose = vi.fn();
        // Never settles: the create is still in flight when the user tries to
        // leave, and dismissing then would strand the outcome.
        vi.mocked(createProject).mockReturnValue(new Promise(() => {}) as never);
        render(<NewProjectModal open onClose={onClose} onCreated={vi.fn()} />);

        await user.type(screen.getByPlaceholderText("Add project name"), "P");
        await submit(user);
        await waitFor(() => expect(createProject).toHaveBeenCalled());

        await user.click(screen.getByRole("button", { name: "Close" }));
        fireEvent.keyDown(document, { key: "Escape" });
        expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps two files that happen to share a name", async () => {
        // The picker deduplicated by NAME, so the second `contract.pdf` — a
        // normal thing to attach from two different folders — was dropped
        // without a word.
        const user = userEvent.setup({ delay: null });
        renderModal();

        await user.type(screen.getByPlaceholderText("Add project name"), "P");
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Next" }));

        const input = document.querySelector(
            'input[type="file"]',
        ) as HTMLInputElement;
        // Two separate picks, as a user attaching from two folders makes
        // them: the name test compared each new file against the ones
        // already staged, so the second one never arrived.
        fireEvent.change(input, {
            target: { files: [new File(["a"], "contract.pdf")] },
        });
        fireEvent.change(input, {
            target: { files: [new File(["b"], "contract.pdf")] },
        });

        expect(
            await screen.findByRole("button", { name: /Upload \(2\)/ }),
        ).toBeInTheDocument();

        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );

        await waitFor(() => expect(uploadProjectDocuments).toHaveBeenCalled());
        const [, sentFiles] = vi.mocked(uploadProjectDocuments).mock.calls[0];
        expect(sentFiles).toHaveLength(2);
        // Each carries its own id, so an outcome can be traced back to the
        // File that produced it rather than to a name they share.
        expect(sentFiles[0].clientId).toBeTruthy();
        expect(sentFiles[0].clientId).not.toBe(sentFiles[1].clientId);
    });

    it("says the attached files are still pending when a grant is refused", async () => {
        // Grants run before the attachments, so a refusal there means nothing
        // the user picked has been sent — an error that mentions only the
        // sharing reads as though the files went in.
        const user = userEvent.setup({ delay: null });
        renderModal();
        vi.mocked(grantProjectAccess).mockRejectedValue(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await user.click(screen.getByRole("button", { name: "Next" }));
        const input = document.querySelector(
            'input[type="file"]',
        ) as HTMLInputElement;
        fireEvent.change(input, {
            target: { files: [new File(["a"], "a.pdf"), new File(["b"], "b.pdf")] },
        });
        await user.click(
            await screen.findByRole("button", { name: "Create project" }),
        );

        expect(
            await screen.findByText(
                /The 2 selected files are still pending and will be attached when you try again\./,
            ),
        ).toBeInTheDocument();
        expect(uploadProjectDocuments).not.toHaveBeenCalled();
    });

    it("keeps Back open once the project exists", async () => {
        // Back stays open: a retry persists a changed memory choice, so the
        // details step still describes something that can change.
        const user = userEvent.setup({ delay: null });
        renderModal();
        vi.mocked(grantProjectAccess).mockRejectedValue(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await user.click(screen.getByRole("button", { name: "Next" }));
        expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();

        await user.click(
            await screen.findByRole("button", { name: "Create project" }),
        );
        await screen.findByText(/Project created, but access was not granted/);

        expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
        await user.click(screen.getByRole("button", { name: "Back" }));
        await user.click(screen.getByRole("button", { name: "Back" }));
        expect(
            screen.getByText(/can no longer be changed here/),
        ).toBeInTheDocument();
    });

    it("locks the identifying fields once the project exists", async () => {
        // The retry reuses the created project and never re-reads the name,
        // CM number or practice, so these stayed editable while every edit
        // made to them on the second attempt was silently dropped.
        const user = userEvent.setup({ delay: null });
        renderModal();
        vi.mocked(grantProjectAccess).mockRejectedValue(
            new MikeApiError({ status: 403, message: "Not allowed" }),
        );

        await fillAndAdd(user, "counsel@firm.test", "editor");
        await submit(user);
        await screen.findByText(/Project created, but access was not granted/);

        await user.click(screen.getByRole("button", { name: "Back" }));
        await user.click(screen.getByRole("button", { name: "Back" }));

        expect(screen.getByLabelText("Project name")).toBeDisabled();
        expect(screen.getByLabelText("CM number")).toBeDisabled();
        expect(screen.getByLabelText("Practice")).toBeDisabled();
        expect(
            screen.getByText(
                /name, CM\s+number and practice can no longer be changed\s+here/,
            ),
        ).toBeInTheDocument();

        // The step is still a retry, not a dead end.
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(screen.getByRole("button", { name: "Next" }));
        await user.click(
            screen.getByRole("button", { name: "Create project" }),
        );

        await waitFor(() =>
            expect(grantProjectAccess).toHaveBeenCalledTimes(2),
        );
        expect(createProject).toHaveBeenCalledTimes(1);
    });
});
