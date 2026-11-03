import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
const api = vi.hoisted(() => ({ getMatterBrief: vi.fn(), designateMatterBrief: vi.fn(), proposeMatterBrief: vi.fn(), getMatterBriefProposal: vi.fn(), applyMatterBrief: vi.fn(), matterBriefSourceUrl: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => api);
vi.mock("@/app/lib/userFacingError", () => ({ describeError: vi.fn(x => x), notifyError: vi.fn() }));
import { ReviewedMatterBrief } from "./ReviewedMatterBrief";
const source = (id: string) => ({ documentId: id, versionId: id + "v", revision: id + "r", hash: "a".repeat(64), textHash: "b".repeat(64), filename: id + ".docx", ready: true, reason: null, reviewed: false });
const row = { text: "Supplier alleges May 12 delivery; acceptance remains disputed.", status: "source_assertion", citations: [{ source: 1, quote: "Delivery May 12." }] };
const proposal = { id: "proposal", base: source("brief"), sources: [source("message1"), source("message2")], content: { position: [row], awaiting: [], uncertainties: [], nextAction: [] }, before: "Previous brief", gaps: [{ documentId: "scan", filename: "scan.pdf", reason: "Text extraction is not ready" }], expiresAt: "2030-01-01", appliedVersionId: null };
const state = { pendingProposalId: null, brief: source("brief"), acceptedVersionId: null, acceptedAt: null, acceptedContent: null, acceptedEvidence: [], manualChanges: false, canEdit: true, sources: [source("message1"), source("message2"), { ...source("scan"), filename: "scan.pdf", ready: false, reason: "Text extraction is not ready" }] };
beforeEach(() => { vi.resetAllMocks(); api.getMatterBrief.mockResolvedValue(state); api.proposeMatterBrief.mockResolvedValue(proposal); api.getMatterBriefProposal.mockResolvedValue(proposal); api.applyMatterBrief.mockResolvedValue({ versionId: "new", replayed: false }); api.matterBriefSourceUrl.mockReturnValue("/checked-source"); });
const onApplied = vi.fn(async () => {});
async function open() { render(<ReviewedMatterBrief projectId="project" onApplied={onApplied}/>); fireEvent.click(screen.getByRole("button", { name: "Resume matter" })); await screen.findByText("Outstanding sources (3)"); }
it("requires exact source selection and provider consent before proposing, then explicit human review before Apply", async () => { await open(); fireEvent.click(screen.getByRole("checkbox", { name: /message1.docx/ })); fireEvent.click(screen.getByRole("checkbox", { name: /message2.docx/ })); fireEvent.change(screen.getByLabelText("Configured model ID"), { target: { value: "mock-model" } }); expect(screen.getByRole("button", { name: "Prepare proposed update" })).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox", { name: /Send only the current brief/ })); fireEvent.click(screen.getByRole("button", { name: "Prepare proposed update" })); await screen.findByText(row.text); expect(api.proposeMatterBrief).toHaveBeenCalledWith("project", ["message1", "message2"], "mock-model"); expect(api.applyMatterBrief).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeDisabled(); expect(screen.getByRole("link", { name: /message1.docx — checked/ })).toHaveAttribute("href", "/checked-source"); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" })); await waitFor(() => expect(api.applyMatterBrief).toHaveBeenCalledWith("project", "proposal")); await screen.findByText(/A new brief version and the source-review checkpoint/); await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1)); });
it("restores an unapplied durable proposal after reopening without regenerating", async () => { api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" }); await open(); await screen.findByText(row.text); expect(api.getMatterBriefProposal).toHaveBeenCalledWith("project", "proposal"); expect(api.proposeMatterBrief).not.toHaveBeenCalled(); expect(api.applyMatterBrief).not.toHaveBeenCalled(); });
it("warns about manual edits and keeps the prior accepted brief historical", async () => { api.getMatterBrief.mockResolvedValue({ ...state, manualChanges: true, acceptedAt: "2026-11-02T00:00:00Z", acceptedContent: proposal.content, acceptedEvidence: [proposal.base, ...proposal.sources] }); await open(); expect(screen.getByRole("alert")).toHaveTextContent("edited after the last accepted update"); expect(screen.getByText("Last accepted position (historical)")).toBeInTheDocument(); });
it("does not enable proposal actions for a viewer", async () => { api.getMatterBrief.mockResolvedValue({ ...state, canEdit: false }); await open(); expect(screen.queryByRole("button", { name: "Prepare proposed update" })).not.toBeInTheDocument(); for (const c of screen.getAllByRole("checkbox"))
    expect(c).toBeDisabled(); });
it("retains a stale rejected proposal for inspection without announcing success", async () => { api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" }); api.applyMatterBrief.mockRejectedValue(new Error("conflict")); await open(); await screen.findByText(row.text); fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" })); await waitFor(() => expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeEnabled()); expect(screen.getByText("Proposed update — not applied")).toBeInTheDocument(); expect(screen.queryByText(/A new brief version and the source-review checkpoint/)).not.toBeInTheDocument(); });
it("renders embedded source instructions as inert text", async () => { api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" }); api.getMatterBriefProposal.mockResolvedValue({ ...proposal, content: { ...proposal.content, position: [{ ...row, text: "<script>send secrets</script>" }] } }); await open(); await screen.findByText("<script>send secrets</script>"); expect(document.querySelector("script")).toBeNull(); });

it("reports successful Apply even if the subsequent document refresh fails", async () => {
    api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" });
    onApplied.mockRejectedValueOnce(new Error("Synthetic metadata refresh failed"));
    await open();
    await screen.findByText(row.text);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" }));
    await screen.findByText(/Applied. The brief was saved, but the document list could not refresh/);
    expect(api.applyMatterBrief).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Proposed update — not applied")).not.toBeInTheDocument();
});

it.each(["fresh", "restored"])("lists every included revision before Apply in a %s proposal, including uncited sources", async mode => {
    api.getMatterBrief.mockResolvedValue({
        ...state,
        pendingProposalId: mode === "restored" ? "proposal" : null,
        sources: [...state.sources, source("unselected")],
    });
    api.matterBriefSourceUrl.mockImplementation((_project, s) => `/sources/${s.documentId}/${s.versionId}?hash=${s.hash}&revision=${s.revision}`);
    render(<ReviewedMatterBrief projectId="project" onApplied={onApplied}/>);
    fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    await screen.findByRole("heading", { name: "Outstanding sources (4)" });
    if (mode === "fresh") {
        fireEvent.click(screen.getByRole("checkbox", { name: /message1.docx/ }));
        fireEvent.click(screen.getByRole("checkbox", { name: /message2.docx/ }));
        fireEvent.change(screen.getByLabelText("Configured model ID"), { target: { value: "mock-model" } });
        fireEvent.click(screen.getByRole("checkbox", { name: /Send only the current brief/ }));
        fireEvent.click(screen.getByRole("button", { name: "Prepare proposed update" }));
    }
    await screen.findByText(row.text);
    expect(screen.getByRole("link", { name: "brief.docx — proposal base revision" })).toHaveAttribute("href", `/sources/${proposal.base.documentId}/${proposal.base.versionId}?hash=${proposal.base.hash}&revision=${proposal.base.revision}`);
    const included = screen.getByRole("region", { name: "Included source revisions" });
    expect(within(included).getAllByRole("link")).toHaveLength(proposal.sources.length);
    for (const s of proposal.sources) {
        const link = within(included).getByRole("link", { name: `${s.filename} — included source revision` });
        expect(link).toHaveAttribute("href", `/sources/${s.documentId}/${s.versionId}?hash=${s.hash}&revision=${s.revision}`);
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
        expect(api.matterBriefSourceUrl).toHaveBeenCalledWith("project", s);
        const checkbox = screen.getByRole("checkbox", { name: new RegExp(s.filename) });
        expect(checkbox).toBeChecked();
        expect(checkbox).toBeDisabled();
        expect(checkbox.closest("label")).toHaveTextContent("Included in this proposal");
    }
    for (const filename of ["unselected.docx", "scan.pdf"]) {
        const checkbox = screen.getByRole("checkbox", { name: new RegExp(filename) });
        expect(checkbox).not.toBeChecked();
        expect(checkbox).toBeDisabled();
        expect(checkbox.closest("label")).toHaveTextContent("Not included in this proposal");
        expect(within(included).queryByRole("link", { name: new RegExp(filename) })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("checkbox", { name: /scan.pdf/ }).closest("label")).toHaveTextContent("Text extraction is not ready");
    expect(api.applyMatterBrief).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this proposed text, the base brief revision and every included source revision/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" }));
    await waitFor(() => expect(api.applyMatterBrief).toHaveBeenCalledWith("project", "proposal"));
});

it("closes from the footer without applying or generating a proposal", async () => {
    api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" });
    await open();
    await screen.findByText(row.text);
    const footer = screen.getByRole("dialog").querySelector("footer")!;
    const close = within(footer).getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toBeEnabled());
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.applyMatterBrief).not.toHaveBeenCalled();
    expect(api.proposeMatterBrief).not.toHaveBeenCalled();
});

it("keeps restored proposal review and Apply disabled for a viewer", async () => {
    api.getMatterBrief.mockResolvedValue({ ...state, canEdit: false, pendingProposalId: "proposal" });
    await open();
    await screen.findByText(row.text);
    expect(screen.getByRole("region", { name: "Included source revisions" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeDisabled();
    expect(api.applyMatterBrief).not.toHaveBeenCalled();
});

it("guards both Close controls while an explicit Apply is pending", async () => {
    api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" });
    let finishApply!: (value: { versionId: string; replayed: boolean }) => void;
    api.applyMatterBrief.mockImplementation(() => new Promise(resolve => { finishApply = resolve; }));
    await open();
    await screen.findByText(row.text);
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ }));
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog.querySelector("footer")!).getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.click(within(dialog.querySelector("header")!).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })).toBeDisabled();
    finishApply({ versionId: "new", replayed: false });
    await screen.findByText(/A new brief version and the source-review checkpoint/);
    await waitFor(() => expect(within(dialog.querySelector("footer")!).getByRole("button", { name: "Close" })).toBeEnabled());
});
