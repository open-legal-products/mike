import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlaybookDrawerProvider, RuleRefButton } from "./PlaybookRuleDrawer";
import type { PlaybookRule } from "./playbookTypes";

const mocks = vi.hoisted(() => ({ listPlaybookRules: vi.fn(), getMe: vi.fn(), updatePlaybookRule: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    listPlaybookRules: mocks.listPlaybookRules,
    getMe: mocks.getMe,
    updatePlaybookRule: mocks.updatePlaybookRule,
}));

const RULE: PlaybookRule = { id: "a", rule_number: "RULE 6", title: "Insurance", description: "Klien mengasuransikan barang.", thresholds: {}, severity: "HIGH", is_active: true, created_at: "2026-09-21T00:00:00Z", updated_at: null };

describe("PlaybookRuleDrawer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.listPlaybookRules.mockResolvedValue([RULE]);
    });

    it("degrades to plain text outside a provider", () => {
        render(<RuleRefButton ruleNumber="RULE 6" />);
        expect(screen.getByText("RULE 6")).toBeInTheDocument();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("opens the rule read-only for non-admins and reports unknown rules", async () => {
        mocks.getMe.mockResolvedValue({ userId: "u1", email: null, isAdmin: false });
        const user = userEvent.setup();
        render(
            <PlaybookDrawerProvider>
                <RuleRefButton ruleNumber="RULE 6" />
                <RuleRefButton ruleNumber="RULE 99" />
            </PlaybookDrawerProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Buka aturan RULE 6" }));
        const dialog = await screen.findByRole("dialog", { name: "Aturan RULE 6" });
        expect(await within(dialog).findByText("Lihat Aturan Playbook")).toBeInTheDocument();
        expect(within(dialog).getByPlaceholderText("Judul aturan")).toBeDisabled();
        expect(within(dialog).queryByRole("button", { name: "Simpan" })).toBeNull();
        await user.keyboard("{Escape}");
        expect(screen.queryByRole("dialog")).toBeNull();

        await user.click(screen.getByRole("button", { name: "Buka aturan RULE 99" }));
        expect(await screen.findByText("Aturan tidak ditemukan")).toBeInTheDocument();
        // Rules were fetched once for both opens.
        expect(mocks.listPlaybookRules).toHaveBeenCalledTimes(1);
    });

    it("lets an admin edit and save from the drawer", async () => {
        mocks.getMe.mockResolvedValue({ userId: "u1", email: null, isAdmin: true });
        mocks.updatePlaybookRule.mockImplementation(async (_id: string, patch: Partial<PlaybookRule>) => ({ ...RULE, ...patch }));
        const user = userEvent.setup();
        render(
            <PlaybookDrawerProvider>
                <RuleRefButton ruleNumber="RULE 6" />
            </PlaybookDrawerProvider>,
        );
        await user.click(screen.getByRole("button", { name: "Buka aturan RULE 6" }));
        const dialog = await screen.findByRole("dialog", { name: "Aturan RULE 6" });
        expect(await within(dialog).findByText("Ubah Aturan Playbook")).toBeInTheDocument();
        await user.click(within(dialog).getByLabelText("Aktif"));
        const desc = within(dialog).getByPlaceholderText(/Deskripsi aturan/);
        await user.clear(desc);
        await user.type(desc, "Klien wajib mengasuransikan barang.");
        await user.click(within(dialog).getByRole("button", { name: "Simpan" }));
        await waitFor(() =>
            expect(mocks.updatePlaybookRule).toHaveBeenCalledWith("a", {
                title: "Insurance",
                description: "Klien wajib mengasuransikan barang.",
                severity: "HIGH",
                is_active: false,
                thresholds: {},
            }),
        );
        expect(screen.queryByRole("dialog")).toBeNull();
    });
});
