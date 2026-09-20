import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MikeApiError } from "@/app/lib/mikeApi";
import { ReviewWorkspace } from "./ReviewWorkspace";
import type { ContractReviewDetail } from "./reviewTypes";

const mocks = vi.hoisted(() => ({
    push: vi.fn(),
    getContract: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1" }, isAuthenticated: true, authLoading: false }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getContract: mocks.getContract,
}));

const DETAIL: ContractReviewDetail = {
    review: {
        id: "r1",
        user_id: "u1",
        title: "PKS — Markas Daging",
        client_name: "Markas Daging",
        document_type: "PKS",
        contract_filename: "a.docx",
        contract_text: "Logistics Services Agreement",
        contract_html: '<table style="width:100%"><tr><td>English</td><td onclick="x()">Indonesia</td></tr></table>',
        contract_docx_path: null,
        contract_pdf_path: null,
        project_context: null,
        review_focus: [],
        ai_output: {
            executive_summary: "Perjanjian ini memiliki beberapa risiko KRITIS.",
            client_name: "Markas Daging",
            contract_type: "PKS",
            template_used: "Client Template",
            overall_recommendation: "NEEDS_REVISIONS",
            risk_level: "CRITICAL",
            red_flags: [
                {
                    id: "RF-001",
                    severity: "CRITICAL",
                    clause: "Pasal 1",
                    title: "Klien Bukan Merupakan Badan Usaha",
                    issue: "Klien adalah perorangan.",
                    business_impact: "Risiko penagihan.",
                    action: "Minta akta perusahaan.",
                    playbook_rule: "RULE 19",
                    requires_approval: "COO",
                },
            ],
            revisions: [
                {
                    id: "REV-001",
                    clause: "Pasal 9",
                    original_text: "Rp 50.000.000",
                    suggested_text: "Rp 10.000.000",
                    rationale: "Sesuai playbook.",
                    priority: "MUST_CHANGE",
                    from_clause_library: false,
                    clause_library_source: null,
                },
            ],
            clarifications: [],
            financial_review: [],
            missing_clauses: [
                {
                    clause_name: "Force Majeure",
                    description: "Tidak ada klausul keadaan kahar.",
                    suggested_wording: "Para Pihak dibebaskan...",
                    importance: "HIGH",
                    from_clause_library: false,
                    clause_library_source: null,
                },
            ],
            yellow_flags: [],
            positive_findings: [],
            section_risks: [],
            playbook_compliance: {
                liability_cap: { status: "non_compliant", assessment: "Batas terlalu tinggi." },
            },
        },
        risk_level: "CRITICAL",
        recommendation: "NEEDS_REVISIONS",
        coo_recommendation_override: null,
        coo_override_rationale: null,
        status: "ai_reviewed",
        lifecycle_stage: "ai_review",
        signing_date: null,
        expiry_date: null,
        renewal_date: null,
        negotiation_memo: null,
        negotiation_memo_generated_at: null,
        created_at: "2026-09-20T10:00:00.000Z",
        updated_at: null,
    },
    feedback: [],
    comments: [],
};

beforeEach(() => {
    vi.clearAllMocks();
    // PageHeader collapses breadcrumbs via a media query; jsdom has no matchMedia.
    Object.defineProperty(window, "matchMedia", {
        writable: true,
        configurable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        }),
    });
});

describe("ReviewWorkspace", () => {
    it("renders the header pills, the sanitized contract, and the Draf sections", async () => {
        mocks.getContract.mockResolvedValue(DETAIL);

        render(<ReviewWorkspace reviewId="r1" />);

        expect(await screen.findByRole("heading", { name: "PKS — Markas Daging" })).toBeInTheDocument();
        expect(screen.getByText("Risiko Kritis")).toBeInTheDocument();
        expect(screen.getByText("PERLU REVISI")).toBeInTheDocument();

        const html = screen.getByTestId("contract-html");
        expect(html.querySelector("table")).not.toBeNull();
        expect(html.innerHTML).not.toContain("onclick");
        expect(html.innerHTML).not.toContain("style=");

        expect(screen.getByText("Ringkasan Eksekutif")).toBeInTheDocument();
        expect(screen.getByText("Kepatuhan Playbook")).toBeInTheDocument();
        expect(screen.getByText("Batas Tanggung Jawab")).toBeInTheDocument();
        expect(screen.getByText("Tidak Sesuai")).toBeInTheDocument();
        expect(screen.getByText("Klien Bukan Merupakan Badan Usaha")).toBeInTheDocument();
        expect(screen.getByText("Rp 10.000.000")).toBeInTheDocument();
        expect(screen.getByText("Force Majeure")).toBeInTheDocument();
        expect(mocks.getContract).toHaveBeenCalledWith("r1");
    });

    it("shows the not-found message on a 404", async () => {
        mocks.getContract.mockRejectedValue(new MikeApiError({ message: "nf", status: 404 }));

        render(<ReviewWorkspace reviewId="missing" />);

        expect(await screen.findByText("Tinjauan tidak ditemukan")).toBeInTheDocument();
    });

    it("shows the processing message while ai_output is empty", async () => {
        mocks.getContract.mockResolvedValue({
            ...DETAIL,
            review: { ...DETAIL.review, ai_output: null, status: "processing" },
        });

        render(<ReviewWorkspace reviewId="r1" />);

        await waitFor(() => expect(screen.getByText("Tinjauan masih diproses...")).toBeInTheDocument());
    });
});
