import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddCommentPopover } from "./AddCommentPopover";

const mocks = vi.hoisted(() => ({ postContractComment: vi.fn(), postContractMissedClause: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    postContractComment: mocks.postContractComment,
    postContractMissedClause: mocks.postContractMissedClause,
}));

const ANCHOR = { text: "Dash liability shall not exceed", start: 42, end: 73, position: { top: 100, left: 50 } };

describe("AddCommentPopover", () => {
    // vi.clearAllMocks, not per-mock clear: vitest 5.0.0 reports a caught
    // rejection as a test failure when the mock was cleared individually first.
    beforeEach(() => vi.clearAllMocks());

    it("saves a revision suggestion with the selected quote, offsets and suggested text", async () => {
        const user = userEvent.setup();
        const row = { id: "c1" };
        mocks.postContractComment.mockResolvedValue(row);
        const onCommentSaved = vi.fn();
        const onClose = vi.fn();
        render(<AddCommentPopover reviewId="r1" anchor={ANCHOR} onClose={onClose} onCommentSaved={onCommentSaved} onSignalSaved={vi.fn()} />);
        expect(screen.getByRole("dialog", { name: "Tambah Komentar" })).toHaveStyle({ top: "100px", left: "50px" });
        expect(screen.getByText(/Dash liability shall not exceed/)).toBeInTheDocument();

        await user.selectOptions(screen.getByLabelText("Jenis komentar"), "revision_suggestion");
        await user.type(screen.getByLabelText("Komentar"), "Turunkan cap");
        await user.type(screen.getByLabelText("Teks yang disarankan"), "10x biaya");
        await user.click(screen.getByRole("button", { name: "Simpan" }));
        await waitFor(() => expect(onCommentSaved).toHaveBeenCalledWith(row));
        expect(mocks.postContractComment).toHaveBeenCalledWith("r1", {
            comment_type: "revision_suggestion",
            comment_text: "Turunkan cap",
            highlight_text: ANCHOR.text,
            suggested_text: "10x biaya",
            highlight_start: 42,
            highlight_end: 73,
        });
        expect(onClose).toHaveBeenCalled();
    });

    it("routes 'AI melewatkan klausul ini' to the missed-clause signal endpoint, never to comments", async () => {
        const user = userEvent.setup();
        mocks.postContractMissedClause.mockResolvedValue({ id: "m1" });
        const onSignalSaved = vi.fn();
        const onCommentSaved = vi.fn();
        render(<AddCommentPopover reviewId="r1" anchor={{ ...ANCHOR, start: -1, end: -1 }} onClose={vi.fn()} onCommentSaved={onCommentSaved} onSignalSaved={onSignalSaved} />);
        await user.selectOptions(screen.getByLabelText("Jenis komentar"), "ai_missed");
        expect(screen.getByRole("dialog", { name: "Tandai sebagai dilewati AI" })).toBeInTheDocument();
        await user.selectOptions(screen.getByLabelText("Kategori yang seharusnya"), "missing_clause");
        await user.type(screen.getByLabelText("Alasan"), "Tidak ada klausul asuransi");
        await user.click(screen.getByRole("button", { name: "Simpan sinyal" }));
        await waitFor(() => expect(onSignalSaved).toHaveBeenCalled());
        expect(mocks.postContractMissedClause).toHaveBeenCalledWith("r1", {
            highlight_text: ANCHOR.text,
            suggested_category: "missing_clause",
            user_note: "Tidak ada klausul asuransi",
            highlight_start: null,
            highlight_end: null,
        });
        expect(mocks.postContractComment).not.toHaveBeenCalled();
        expect(onCommentSaved).not.toHaveBeenCalled();
    });

    it("closes on Escape and on Batal, and shows API errors", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        mocks.postContractComment.mockRejectedValue(new Error("fail"));
        render(<AddCommentPopover reviewId="r1" anchor={ANCHOR} onClose={onClose} onCommentSaved={vi.fn()} onSignalSaved={vi.fn()} />);
        await user.type(screen.getByLabelText("Komentar"), "x");
        await user.click(screen.getByRole("button", { name: "Simpan" }));
        await waitFor(() => expect(screen.getByText(/Gagal menyimpan|fail/)).toBeInTheDocument());
        expect(onClose).not.toHaveBeenCalled();
        await user.keyboard("{Escape}");
        expect(onClose).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole("button", { name: "Batal" }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
