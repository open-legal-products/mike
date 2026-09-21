import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlaybookAdmin } from "./PlaybookAdmin";
import type { PlaybookRule } from "./playbookTypes";

const mocks = vi.hoisted(() => ({
    listPlaybookRules: vi.fn(),
    getMe: vi.fn(),
    createPlaybookRule: vi.fn(),
    updatePlaybookRule: vi.fn(),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" }, isAuthenticated: true, authLoading: false }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listPlaybookRules: mocks.listPlaybookRules,
    getMe: mocks.getMe,
    createPlaybookRule: mocks.createPlaybookRule,
    updatePlaybookRule: mocks.updatePlaybookRule,
}));

const RULES: PlaybookRule[] = [
    { id: "a", rule_number: "RULE 1", title: "Liability cap", description: "≤ 10x biaya.", thresholds: { max_multiple: 10 }, severity: "CRITICAL", is_active: true, created_at: "2026-09-21T00:00:00Z", updated_at: null },
    { id: "b", rule_number: "RULE 2", title: "Indemnity", description: "Asimetri.", thresholds: {}, severity: "HIGH", is_active: false, created_at: "2026-09-21T00:00:00Z", updated_at: null },
];

describe("PlaybookAdmin", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listPlaybookRules.mockResolvedValue(RULES);
    });

    it("lists rules with the active count and hides editing from non-admins", async () => {
        mocks.getMe.mockResolvedValue({ userId: "u1", email: null, isAdmin: false });
        const user = userEvent.setup();
        render(<PlaybookAdmin />);
        expect(await screen.findByRole("heading", { name: "1 Aturan Aktif" })).toBeInTheDocument();
        expect(screen.getByText("Hanya admin yang dapat mengedit")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Tambah Aturan/ })).toBeNull();
        expect(within(screen.getByTestId("rule-RULE 2")).getByText("Nonaktif")).toBeInTheDocument();

        await user.click(within(screen.getByTestId("rule-RULE 1")).getByRole("button", { expanded: false }));
        expect(screen.getByText("≤ 10x biaya.")).toBeInTheDocument();
        expect(screen.getByText("max_multiple: 10")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /Ubah/ })).toBeNull();
    });

    it("lets an admin create a rule, validating the thresholds JSON first", async () => {
        mocks.getMe.mockResolvedValue({ userId: "u1", email: null, isAdmin: true });
        const created: PlaybookRule = { ...RULES[0], id: "c", rule_number: "RULE 15", title: "Baru", description: "Desk", thresholds: { min_months: 6 }, severity: "MEDIUM" };
        mocks.createPlaybookRule.mockResolvedValue(created);
        const user = userEvent.setup();
        render(<PlaybookAdmin />);
        await user.click(await screen.findByRole("button", { name: /Tambah Aturan/ }));
        const dialog = screen.getByRole("dialog");
        await user.type(within(dialog).getByPlaceholderText("cth. RULE 15"), "RULE 15");
        await user.type(within(dialog).getByPlaceholderText("Judul aturan"), "Baru");
        await user.type(within(dialog).getByPlaceholderText(/Deskripsi aturan/), "Desk");
        await user.selectOptions(within(dialog).getByRole("combobox"), "MEDIUM");
        const thresholds = within(dialog).getByPlaceholderText('{"min_months": 6}');
        await user.clear(thresholds);
        await user.type(thresholds, "not json");
        await user.click(within(dialog).getByRole("button", { name: "Buat" }));
        expect(await within(dialog).findByText("JSON thresholds tidak valid.")).toBeInTheDocument();
        expect(mocks.createPlaybookRule).not.toHaveBeenCalled();

        await user.clear(thresholds);
        await user.type(thresholds, '{{"min_months": 6}');
        await user.click(within(dialog).getByRole("button", { name: "Buat" }));
        await waitFor(() => expect(mocks.createPlaybookRule).toHaveBeenCalledWith({ rule_number: "RULE 15", title: "Baru", description: "Desk", thresholds: { min_months: 6 }, severity: "MEDIUM" }));
        expect(await screen.findByText("Aturan dibuat.")).toBeInTheDocument();
        expect(screen.getByTestId("rule-RULE 15")).toBeInTheDocument();
        expect(screen.getByRole("heading", { name: "2 Aturan Aktif" })).toBeInTheDocument();
    });

    it("toggles a rule's active flag and edits it in place", async () => {
        mocks.getMe.mockResolvedValue({ userId: "u1", email: null, isAdmin: true });
        mocks.updatePlaybookRule.mockImplementation(async (id: string, patch: Partial<PlaybookRule>) => ({ ...RULES.find((r) => r.id === id)!, ...patch }));
        const user = userEvent.setup();
        render(<PlaybookAdmin />);
        const row = await screen.findByTestId("rule-RULE 2");
        await user.click(within(row).getByRole("button", { expanded: false }));
        await user.click(within(row).getByRole("button", { name: /Aktifkan/ }));
        await waitFor(() => expect(mocks.updatePlaybookRule).toHaveBeenCalledWith("b", { is_active: true }));
        expect(await screen.findByRole("heading", { name: "2 Aturan Aktif" })).toBeInTheDocument();

        await user.click(within(row).getByRole("button", { name: /Ubah/ }));
        const dialog = screen.getByRole("dialog");
        const title = within(dialog).getByPlaceholderText("Judul aturan");
        await user.clear(title);
        await user.type(title, "Indemnity (rev)");
        await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
        await waitFor(() => expect(mocks.updatePlaybookRule).toHaveBeenLastCalledWith("b", expect.objectContaining({ title: "Indemnity (rev)", rule_number: "RULE 2" })));
        expect(await screen.findByText(/Aturan diperbarui/)).toBeInTheDocument();
        expect(within(screen.getByTestId("rule-RULE 2")).getByText("Indemnity (rev)")).toBeInTheDocument();
    });
});
