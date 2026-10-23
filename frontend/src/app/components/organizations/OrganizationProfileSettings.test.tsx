import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MikeApiError, type Org, type OrgProfile } from "@/app/lib/mikeApi";
import { OrganizationProfileSettings } from "./OrganizationProfileSettings";

// The Workspace profile section of an organization's settings. What this pins:
//
//   - the stored profile fills the form
//   - owners and admins save the whole profile; jurisdiction codes are typed
//     as a comma-separated list and saved as upper-case codes
//   - the server's reason for refusing a profile is shown where it was typed
//   - a member reads the profile and cannot change it

const STORED: OrgProfile = {
  group_name: "Example Group",
  headquarters_jurisdiction: "NL",
  operating_jurisdictions: ["NL"],
  fiscal_year_end: "12-31",
  reporting_currency: "EUR",
  group_structure: "Holding in NL.",
  house_positions: null,
  standing_instructions: null,
  reviewed_on: "2026-10-01",
  updated_at: "2026-10-01T09:00:00Z",
};

const mocks = vi.hoisted(() => ({
  org: null as Org | null,
  getOrgProfile: vi.fn(),
  saveOrgProfile: vi.fn(),
}));

vi.mock("./OrganizationSettingsShell", () => ({
  useOrganizationSettings: () => ({
    orgId: "org-1",
    org: mocks.org,
    setOrg: vi.fn(),
    reload: vi.fn(),
  }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
  getOrgProfile: mocks.getOrgProfile,
  saveOrgProfile: mocks.saveOrgProfile,
}));

function asRole(role: "owner" | "admin" | "member") {
  mocks.org = { id: "org-1", name: "Acme", role } as unknown as Org;
}

beforeEach(() => {
  vi.clearAllMocks();
  asRole("owner");
  mocks.getOrgProfile.mockResolvedValue(STORED);
  mocks.saveOrgProfile.mockImplementation(async (_orgId: string, input: object) => ({
    ...STORED,
    ...input,
    updated_at: "2026-10-18T12:00:00Z",
  }));
});

describe("OrganizationProfileSettings", () => {
  it("fills the form with the stored profile", async () => {
    render(<OrganizationProfileSettings />);
    expect(await screen.findByLabelText("Group name")).toHaveValue("Example Group");
    expect(screen.getByLabelText("Operating jurisdictions")).toHaveValue("NL");
    expect(screen.getByLabelText("Reporting currency")).toHaveValue("EUR");
    expect(screen.getByLabelText("Group structure")).toHaveValue("Holding in NL.");
    expect(mocks.getOrgProfile).toHaveBeenCalledWith("org-1");
    expect(
      screen.getByText(
        "Reference context for each member's own chats in this workspace that no one else can see; project and tabular review chats do not get it. It is never an instruction and never a source.",
      ),
    ).toBeInTheDocument();
  });

  it("saves the whole profile with jurisdictions as upper-case codes", async () => {
    const user = userEvent.setup();
    render(<OrganizationProfileSettings />);
    const name = await screen.findByLabelText("Group name");
    await user.clear(name);
    await user.type(name, "New Group");
    const codes = screen.getByLabelText("Operating jurisdictions");
    await user.clear(codes);
    await user.type(codes, "nl, de");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.saveOrgProfile).toHaveBeenCalledTimes(1));
    expect(mocks.saveOrgProfile).toHaveBeenCalledWith("org-1", {
      group_name: "New Group",
      headquarters_jurisdiction: "NL",
      operating_jurisdictions: ["NL", "DE"],
      fiscal_year_end: "12-31",
      reporting_currency: "EUR",
      group_structure: "Holding in NL.",
      house_positions: null,
      standing_instructions: null,
      reviewed_on: "2026-10-01",
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows the server's reason when it refuses the profile", async () => {
    const user = userEvent.setup();
    mocks.saveOrgProfile.mockRejectedValue(
      new MikeApiError({
        message: "reporting_currency must be a three-letter code such as EUR.",
        status: 400,
      }),
    );
    render(<OrganizationProfileSettings />);
    await screen.findByLabelText("Group name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "reporting_currency must be a three-letter code such as EUR.",
    );
  });

  it("lets a member read the profile but not change it", async () => {
    asRole("member");
    render(<OrganizationProfileSettings />);
    expect(await screen.findByLabelText("Group name")).toBeDisabled();
    expect(screen.getByLabelText("House positions")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});
