import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentsTab } from "./CommentsTab";
import type { ManualCommentRow } from "./reviewTypes";

const mocks = vi.hoisted(() => ({ postContractComment: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    postContractComment: mocks.postContractComment,
}));

function comment(partial: Partial<ManualCommentRow>): ManualCommentRow {
    return { id: "c1", review_id: "r1", user_id: "u1", user_name: "aditya", comment_type: "note", highlight_text: null, highlight_start: null, highlight_end: null, comment_text: "hi", suggested_text: null, parent_comment_id: null, created_at: "2026-09-20T10:00:00Z", ...partial } as ManualCommentRow;
}

const TEXT = "Alpha clause text. Beta clause text. Gamma clause text.";

describe("CommentsTab", () => {
    beforeEach(() => vi.clearAllMocks());

    it("shows the empty state with the selection hint", () => {
        render(<CommentsTab reviewId="r1" comments={[]} contractText={TEXT} onLocate={vi.fn()} onCommentSaved={vi.fn()} />);
        expect(screen.getByText("Belum ada komentar.")).toBeInTheDocument();
        expect(screen.getByText(/Sorot teks pada dokumen/)).toBeInTheDocument();
    });

    it("orders root comments by document position, nests replies, and locates quotes", async () => {
        const user = userEvent.setup();
        const onLocate = vi.fn();
        const comments = [
            comment({ id: "late", highlight_text: "Gamma clause", comment_text: "third", comment_type: "question" }),
            comment({ id: "early", highlight_text: "Alpha clause", comment_text: "first", comment_type: "revision_suggestion", suggested_text: "Alpha revised" }),
            comment({ id: "reply", parent_comment_id: "early", comment_text: "a reply", user_name: "robert" }),
            comment({ id: "unanchored", comment_text: "no quote" }),
        ];
        render(<CommentsTab reviewId="r1" comments={comments} contractText={TEXT} onLocate={onLocate} onCommentSaved={vi.fn()} />);
        const cards = screen.getAllByTestId(/^comment-/);
        expect(cards.map((c) => c.getAttribute("data-testid"))).toEqual(["comment-early", "comment-late", "comment-unanchored"]);
        const early = screen.getByTestId("comment-early");
        expect(within(early).getByText("Saran Revisi")).toBeInTheDocument();
        expect(within(early).getByText("Alpha revised")).toBeInTheDocument();
        expect(within(early).getByText("a reply")).toBeInTheDocument();
        expect(within(early).getByText("robert")).toBeInTheDocument();
        expect(within(screen.getByTestId("comment-late")).getByText("Pertanyaan")).toBeInTheDocument();
        expect(within(screen.getByTestId("comment-unanchored")).queryByText("Lihat di dokumen")).toBeNull();

        await user.click(within(early).getByRole("button", { name: /Lihat di dokumen/ }));
        expect(onLocate).toHaveBeenCalledWith("Alpha clause");
    });

    it("posts a reply as a note under the parent and resets the composer", async () => {
        const user = userEvent.setup();
        const saved = comment({ id: "r9", parent_comment_id: "c1", comment_text: "Setuju" });
        mocks.postContractComment.mockResolvedValue(saved);
        const onCommentSaved = vi.fn();
        render(<CommentsTab reviewId="r1" comments={[comment({})]} contractText={TEXT} onLocate={vi.fn()} onCommentSaved={onCommentSaved} />);
        await user.click(screen.getByRole("button", { name: /Balas/ }));
        const kirim = screen.getByRole("button", { name: "Kirim" });
        expect(kirim).toBeDisabled();
        await user.type(screen.getByLabelText("Balasan"), "Setuju");
        await user.click(kirim);
        await waitFor(() => expect(onCommentSaved).toHaveBeenCalledWith(saved));
        expect(mocks.postContractComment).toHaveBeenCalledWith("r1", { comment_type: "note", comment_text: "Setuju", parent_comment_id: "c1" });
        expect(screen.queryByLabelText("Balasan")).toBeNull();
    });

    it("shows an error when the reply fails", async () => {
        const user = userEvent.setup();
        mocks.postContractComment.mockRejectedValue(new Error("nope"));
        render(<CommentsTab reviewId="r1" comments={[comment({})]} contractText={TEXT} onLocate={vi.fn()} onCommentSaved={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: /Balas/ }));
        await user.type(screen.getByLabelText("Balasan"), "x");
        await user.click(screen.getByRole("button", { name: "Kirim" }));
        await waitFor(() => expect(screen.getByText(/Balasan gagal disimpan|nope/)).toBeInTheDocument());
    });
});
