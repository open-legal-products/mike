import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabularFindings } from "./TabularFindings";
import type { FindingAnnotation } from "./findingAnnotations";
import type { ReviewFeedbackRow } from "./reviewTypes";

const mocks = vi.hoisted(() => ({ postContractFeedbackBulk: vi.fn() }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    postContractFeedbackBulk: mocks.postContractFeedbackBulk,
}));

function ann(partial: Partial<FindingAnnotation> & Pick<FindingAnnotation, "id" | "type">): FindingAnnotation {
    return { key: `${partial.type}:${partial.id}`, highlightText: "some highlighted quote", position: 0, clause: "Pasal 1", summary: `Summary ${partial.id}`, ...partial };
}

const ROWS: FindingAnnotation[] = [
    ann({ id: "RF-001", type: "red_flag", severity: "CRITICAL", summary: "Liability cap too high", playbookRule: "RULE 1" }),
    ann({ id: "REV-001", type: "revision", severity: "MUST_CHANGE", summary: "Net 30" }),
    ann({ id: "CLR-001", type: "clarification", summary: "Siapa PIC?" }),
    ann({ id: "PF-0", type: "positive", summary: "Hukum Indonesia" }),
    ann({ id: "RF-002", type: "red_flag", severity: "HIGH", summary: "Already dismissed", feedback: { action: "dismiss" } as ReviewFeedbackRow }),
];

describe("TabularFindings", () => {
    beforeEach(() => vi.clearAllMocks());

    it("renders every annotation with counts, filters by type and status, and searches", async () => {
        const user = userEvent.setup();
        render(<TabularFindings reviewId="r1" annotations={ROWS} onLocate={vi.fn()} onFeedbackSaved={vi.fn()} />);
        expect(screen.getAllByTestId(/^row-/)).toHaveLength(5);
        expect(screen.getByText(/4 belum ditinjau/)).toBeInTheDocument();
        expect(screen.getByText("RULE 1")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Tanda Bahaya" }));
        expect(screen.getAllByTestId(/^row-/)).toHaveLength(2);
        await user.click(screen.getByRole("button", { name: "Diabaikan" }));
        expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
        expect(screen.getByTestId("row-red_flag:RF-002")).toHaveClass("opacity-60");

        await user.click(screen.getByRole("button", { name: "Semua" }));
        await user.click(screen.getByRole("button", { name: "Semua status" }));
        await user.type(screen.getByLabelText("Cari temuan"), "PIC");
        expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
        expect(screen.getByText("Siapa PIC?")).toBeInTheDocument();
    });

    it("clicking a summary locates its quote in the document", async () => {
        const user = userEvent.setup();
        const onLocate = vi.fn();
        render(<TabularFindings reviewId="r1" annotations={ROWS} onLocate={onLocate} onFeedbackSaved={vi.fn()} />);
        await user.click(screen.getByText("Liability cap too high"));
        expect(onLocate).toHaveBeenCalledWith("some highlighted quote");
    });

    it("bulk-confirms only pending rows with an applicable verb and reports skipped ones", async () => {
        const user = userEvent.setup();
        const saved: ReviewFeedbackRow[] = [{ id: "f1" } as ReviewFeedbackRow];
        mocks.postContractFeedbackBulk.mockResolvedValue(saved);
        const onFeedbackSaved = vi.fn();
        render(<TabularFindings reviewId="r1" annotations={ROWS} onLocate={vi.fn()} onFeedbackSaved={onFeedbackSaved} />);

        // Reviewed / dismissed / positive rows cannot be selected.
        expect(screen.getByLabelText("Pilih RF-002")).toBeDisabled();
        await user.click(screen.getByLabelText("Pilih semua temuan yang masih bisa ditindaklanjuti"));
        expect(within(screen.getByTestId("bulk-bar")).getByText("4")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /Tandai valid/ }));
        await waitFor(() => expect(mocks.postContractFeedbackBulk).toHaveBeenCalledTimes(1));
        const [, items] = mocks.postContractFeedbackBulk.mock.calls[0];
        // Clarification and positive have no "valid" verb → skipped.
        expect(items).toEqual([
            expect.objectContaining({ finding_type: "red_flag", finding_id: "RF-001", action: "valid", original_severity: "CRITICAL", rationale: null }),
            expect.objectContaining({ finding_type: "revision", finding_id: "REV-001", action: "accept" }),
        ]);
        expect(onFeedbackSaved).toHaveBeenCalledWith(saved);
        expect(screen.getByRole("status")).toHaveTextContent("2 temuan ditandai valid, 2 dilewati");
        expect(screen.queryByTestId("bulk-bar")).not.toBeInTheDocument();
    });

    it("bulk dismiss requires a rationale and uses the per-type verb", async () => {
        const user = userEvent.setup();
        mocks.postContractFeedbackBulk.mockResolvedValue([]);
        render(<TabularFindings reviewId="r1" annotations={ROWS} onLocate={vi.fn()} onFeedbackSaved={vi.fn()} />);
        await user.click(screen.getByLabelText("Pilih REV-001"));
        await user.click(screen.getByLabelText("Pilih CLR-001"));
        await user.click(screen.getByRole("button", { name: /^Abaikan$/ }));
        const confirm = screen.getByRole("button", { name: /Abaikan 2 temuan/ });
        expect(confirm).toBeDisabled();
        await user.type(screen.getByLabelText("Alasan mengabaikan"), "Sudah dibahas dengan klien");
        await user.click(confirm);
        await waitFor(() => expect(mocks.postContractFeedbackBulk).toHaveBeenCalledTimes(1));
        expect(mocks.postContractFeedbackBulk.mock.calls[0][1]).toEqual([
            expect.objectContaining({ finding_id: "REV-001", action: "reject", rationale: "Sudah dibahas dengan klien" }),
            expect.objectContaining({ finding_id: "CLR-001", action: "skip", rationale: "Sudah dibahas dengan klien" }),
        ]);
    });

    it("surfaces API failures without clearing the selection", async () => {
        const user = userEvent.setup();
        mocks.postContractFeedbackBulk.mockRejectedValue(new Error("boom"));
        render(<TabularFindings reviewId="r1" annotations={ROWS} onLocate={vi.fn()} onFeedbackSaved={vi.fn()} />);
        await user.click(screen.getByLabelText("Pilih RF-001"));
        await user.click(screen.getByRole("button", { name: /Tandai valid/ }));
        await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Gagal menyimpan umpan balik|boom/));
        expect(screen.getByTestId("bulk-bar")).toBeInTheDocument();
    });
});
