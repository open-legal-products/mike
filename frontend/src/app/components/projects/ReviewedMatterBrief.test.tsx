import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
const api = vi.hoisted(() => ({ getMatterBrief: vi.fn(), designateMatterBrief: vi.fn(), proposeMatterBrief: vi.fn(), getMatterBriefProposal: vi.fn(), applyMatterBrief: vi.fn(), matterBriefSourceUrl: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => api);
vi.mock("@/app/lib/userFacingError", () => ({ describeError: vi.fn(x => x), notifyError: vi.fn() }));
import { ReviewedMatterBrief } from "./ReviewedMatterBrief";
import { notifyError } from "@/app/lib/userFacingError";
const source = (id: string) => ({ documentId: id, versionId: id + "v", revision: id + "r", hash: "a".repeat(64), textHash: "b".repeat(64), filename: id + ".docx", fileType: "docx", ready: true, reason: null, reviewed: false });
const row = { text: "Supplier alleges May 12 delivery; acceptance remains disputed.", status: "source_assertion", citations: [{ source: 1, quote: "Delivery May 12." }] };
const proposal = { id: "proposal", base: source("brief"), sources: [source("message1"), source("message2")], content: { position: [row], awaiting: [], uncertainties: [], nextAction: [] }, before: "Previous brief", gaps: [{ documentId: "scan", filename: "scan.pdf", reason: "Text extraction is not ready" }], expiresAt: "2030-01-01", appliedVersionId: null };
const state = { pendingProposalId: null, brief: source("brief"), acceptedVersionId: null, acceptedAt: null, acceptedContent: null, acceptedEvidence: [], manualChanges: false, canEdit: true, sources: [source("message1"), source("message2"), { ...source("scan"), filename: "scan.pdf", ready: false, reason: "Text extraction is not ready" }] };
beforeEach(() => { vi.resetAllMocks(); api.getMatterBrief.mockResolvedValue(state); api.proposeMatterBrief.mockResolvedValue(proposal); api.getMatterBriefProposal.mockResolvedValue(proposal); api.applyMatterBrief.mockResolvedValue({ versionId: "new", replayed: false }); api.matterBriefSourceUrl.mockReturnValue("/checked-source"); });
const onApplied = vi.fn(async () => {});
async function open(outstanding = 3) { render(<ReviewedMatterBrief projectId="project" onApplied={onApplied}/>); fireEvent.click(screen.getByRole("button", { name: "Resume matter" })); await screen.findByText(`Outstanding sources (${outstanding})`); }
function approveDisplayedProposal() {
    fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /I compared the current brief/ }));
}
it("requires exact source selection and provider consent before proposing, then explicit human review before Apply", async () => { await open(); fireEvent.click(screen.getByRole("checkbox", { name: /message1.docx/ })); fireEvent.click(screen.getByRole("checkbox", { name: /message2.docx/ })); fireEvent.change(screen.getByLabelText("Configured model ID"), { target: { value: "mock-model" } }); expect(screen.getByRole("button", { name: "Prepare proposed update" })).toBeDisabled(); fireEvent.click(screen.getByRole("checkbox", { name: /Send only the current brief/ })); fireEvent.click(screen.getByRole("button", { name: "Prepare proposed update" })); await screen.findByText(row.text); expect(api.proposeMatterBrief).toHaveBeenCalledWith("project", ["message1", "message2"], "mock-model"); expect(api.applyMatterBrief).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeDisabled(); expect(screen.getByRole("link", { name: /message1.docx — checked/ })).toHaveAttribute("href", "/checked-source"); approveDisplayedProposal(); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" })); await waitFor(() => expect(api.applyMatterBrief).toHaveBeenCalledWith("project", "proposal")); await screen.findByText(/A new brief version and the source-review checkpoint/); await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1)); });
it("restores an unapplied durable proposal after reopening without regenerating", async () => { api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" }); await open(); await screen.findByText(row.text); expect(api.getMatterBriefProposal).toHaveBeenCalledWith("project", "proposal"); expect(api.proposeMatterBrief).not.toHaveBeenCalled(); expect(api.applyMatterBrief).not.toHaveBeenCalled(); });
it("warns about manual edits and keeps the prior accepted brief historical", async () => { api.getMatterBrief.mockResolvedValue({ ...state, manualChanges: true, acceptedAt: "2026-11-02T00:00:00Z", acceptedContent: proposal.content, acceptedEvidence: [proposal.base, ...proposal.sources] }); await open(); expect(screen.getByRole("alert")).toHaveTextContent("edited after the last accepted update"); expect(screen.getByText("Last accepted position (historical)")).toBeInTheDocument(); });
it("does not enable proposal actions for a viewer", async () => { api.getMatterBrief.mockResolvedValue({ ...state, canEdit: false }); await open(); expect(screen.queryByRole("button", { name: "Prepare proposed update" })).not.toBeInTheDocument(); for (const c of screen.getAllByRole("checkbox"))
    expect(c).toBeDisabled(); });
it("retains a stale rejected proposal for inspection without announcing success", async () => { api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" }); api.applyMatterBrief.mockRejectedValue(new Error("conflict")); await open(); await screen.findByText(row.text); approveDisplayedProposal(); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" })); await waitFor(() => expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeEnabled()); expect(screen.getByText("Proposed update — not applied")).toBeInTheDocument(); expect(screen.queryByText(/A new brief version and the source-review checkpoint/)).not.toBeInTheDocument(); });
it("renders embedded source instructions as inert text", async () => { api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" }); api.getMatterBriefProposal.mockResolvedValue({ ...proposal, content: { ...proposal.content, position: [{ ...row, text: "<script>send secrets</script>" }] } }); await open(); await screen.findByText("<script>send secrets</script>"); expect(document.querySelector("script")).toBeNull(); });

it("reports successful Apply even if the subsequent document refresh fails", async () => {
    api.getMatterBrief.mockResolvedValueOnce({ ...state, pendingProposalId: "proposal" }).mockResolvedValue(state);
    onApplied.mockRejectedValueOnce(new Error("Synthetic metadata refresh failed"));
    await open();
    await screen.findByText(row.text);
    approveDisplayedProposal();
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
    expect(screen.getByRole("link", { name: "message1.docx — checked source revision" })).toHaveAttribute("href", `/sources/${proposal.sources[0].documentId}/${proposal.sources[0].versionId}?hash=${proposal.sources[0].hash}&revision=${proposal.sources[0].revision}`);
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
    approveDisplayedProposal();
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
    expect(screen.getByRole("checkbox", { name: /I compared the current brief/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeDisabled();
    expect(api.applyMatterBrief).not.toHaveBeenCalled();
});

it("guards both Close controls while an explicit Apply is pending", async () => {
    api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" });
    let finishApply!: (value: { versionId: string; replayed: boolean }) => void;
    api.applyMatterBrief.mockImplementation(() => new Promise(resolve => { finishApply = resolve; }));
    await open();
    await screen.findByText(row.text);
    approveDisplayedProposal();
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog.querySelector("footer")!).getByRole("button", { name: "Close" })).toBeDisabled();
    fireEvent.click(within(dialog.querySelector("header")!).getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /I compared the current brief/ })).toBeDisabled();
    finishApply({ versionId: "new", replayed: false });
    await screen.findByText(/A new brief version and the source-review checkpoint/);
    await waitFor(() => expect(within(dialog.querySelector("footer")!).getByRole("button", { name: "Close" })).toBeEnabled());
});

it("requires both independent confirmations in either order before Apply", async () => {
    api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" });
    await open();
    await screen.findByText(row.text);
    expect(screen.getByText("Applying replaces the entire current brief with this generated document. Manual notes, tables and formatting may not carry over. The previous version remains available in document version history.")).toBeVisible();
    const review = screen.getByRole("checkbox", { name: /I reviewed this proposed text/ });
    const comparison = screen.getByRole("checkbox", { name: /I compared the current brief/ });
    const apply = screen.getByRole("button", { name: "Apply reviewed update" });
    expect(comparison).toHaveAccessibleName(/as a new project-visible version/);
    expect(review).not.toBeChecked(); expect(comparison).not.toBeChecked(); expect(apply).toBeDisabled();
    fireEvent.click(review); expect(apply).toBeDisabled();
    fireEvent.click(review); fireEvent.click(comparison); expect(apply).toBeDisabled();
    expect(api.applyMatterBrief).not.toHaveBeenCalled();
    fireEvent.click(review); expect(apply).toBeEnabled(); fireEvent.click(apply);
    await waitFor(() => expect(api.applyMatterBrief).toHaveBeenCalledWith("project", "proposal"));
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function contextState(project: string, pending = false) {
    return { ...state, brief: source(project + "-brief"), sources: [source(project + "-source")], pendingProposalId: pending ? project + "-proposal" : null };
}
function contextProposal(project: string) {
    return { ...proposal, id: project + "-proposal", base: source(project + "-brief"), sources: [source(project + "-source")], before: project + " prior position", content: { ...proposal.content, position: [{ ...row, text: project + " proposed position" }] } };
}
it.each([false, true])("ignores a late proposal after project navigation, including returning to the original project=%s", async returnToOriginal => {
    const pending = deferred<typeof proposal>();
    api.getMatterBrief.mockImplementation(async (project: string) => contextState(project));
    api.proposeMatterBrief.mockReturnValue(pending.promise);
    const view = render(<ReviewedMatterBrief projectId="matter-a" onApplied={onApplied}/>);
    fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    await screen.findByRole("link", { name: "Open current brief: matter-a-brief.docx" });
    fireEvent.click(screen.getByRole("checkbox", { name: /matter-a-source.docx/ }));
    fireEvent.change(screen.getByLabelText("Configured model ID"), { target: { value: "mock-model" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Send only the current brief/ }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare proposed update" }));
    await waitFor(() => expect(api.proposeMatterBrief).toHaveBeenCalledWith("matter-a", ["matter-a-source"], "mock-model"));
    view.rerender(<ReviewedMatterBrief projectId="matter-b" onApplied={onApplied}/>);
    await screen.findByRole("link", { name: "Open current brief: matter-b-brief.docx" });
    if (returnToOriginal) {
        view.rerender(<ReviewedMatterBrief projectId="matter-a" onApplied={onApplied}/>);
        await screen.findByRole("link", { name: "Open current brief: matter-a-brief.docx" });
    }
    await act(async () => { pending.resolve(contextProposal("matter-a")); });
    expect(screen.queryByText("matter-a proposed position")).not.toBeInTheDocument();
    expect(screen.queryByText("Proposed update — not applied")).not.toBeInTheDocument();
    expect(api.applyMatterBrief).not.toHaveBeenCalled();
});
it("does not show a late Apply result or refresh the previous project after navigation", async () => {
    const pending = deferred<{ versionId: string; replayed: boolean }>();
    api.getMatterBrief.mockImplementation(async (project: string) => contextState(project, project === "matter-a"));
    api.getMatterBriefProposal.mockResolvedValue(contextProposal("matter-a"));
    api.applyMatterBrief.mockReturnValue(pending.promise);
    const view = render(<ReviewedMatterBrief projectId="matter-a" onApplied={onApplied}/>);
    fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    await screen.findByText("matter-a proposed position");
    approveDisplayedProposal();
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" }));
    await waitFor(() => expect(api.applyMatterBrief).toHaveBeenCalledWith("matter-a", "matter-a-proposal"));
    view.rerender(<ReviewedMatterBrief projectId="matter-b" onApplied={onApplied}/>);
    await screen.findByRole("link", { name: "Open current brief: matter-b-brief.docx" });
    await act(async () => { pending.resolve({ versionId: "matter-a-applied", replayed: false }); });
    expect(screen.queryByText(/A new brief version and the source-review checkpoint/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open current brief: matter-b-brief.docx" })).toBeInTheDocument();
    expect(api.getMatterBrief.mock.calls.filter(([project]) => project === "matter-a")).toHaveLength(1);
    expect(onApplied).not.toHaveBeenCalled();
});
it.each(["fresh", "restored"])("shows omitted prior positions by default and separately requires removal consent for a %s proposal", async mode => {
    const before = "Maintain the separate price-adjustment claim. Await litigation instructions before settlement.";
    const replacement = { ...proposal, before, sources: [source("message1")] };
    api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: mode === "restored" ? "proposal" : null, sources: [{ ...source("message1"), reviewed: true }, ...state.sources.slice(1)] });
    api.getMatterBriefProposal.mockResolvedValue(replacement);
    api.proposeMatterBrief.mockResolvedValue(replacement);
    await open(2);
    if (mode === "fresh") {
        fireEvent.click(screen.getByRole("checkbox", { name: /message1.docx/ }));
        fireEvent.change(screen.getByLabelText("Configured model ID"), { target: { value: "mock-model" } });
        fireEvent.click(screen.getByRole("checkbox", { name: /Send only the current brief/ }));
        fireEvent.click(screen.getByRole("button", { name: "Prepare proposed update" }));
    }
    await screen.findByText(row.text);
    const current = screen.getByText("Current brief — will be replaced").closest("details")!;
    expect(current).toHaveAttribute("open"); expect(within(current).getByText(before)).toBeVisible();
    const after = screen.getByRole("region", { name: "Complete proposed replacement" });
    expect(after).not.toHaveTextContent("price-adjustment claim"); expect(after).not.toHaveTextContent("Await litigation instructions");
    expect(screen.getByText(/Omission does not mean an item is resolved or withdrawn/)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /message1.docx/ }).closest("label")).toHaveTextContent("Reviewed revision");
    expect(screen.getByRole("checkbox", { name: /message2.docx/ }).closest("label")).toHaveTextContent("Not reviewed");
    const review = screen.getByRole("checkbox", { name: /I reviewed this proposed text/ });
    const comparison = screen.getByRole("checkbox", { name: /I compared the current brief/ });
    fireEvent.click(review); expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeDisabled();
    expect(api.applyMatterBrief).not.toHaveBeenCalled(); fireEvent.click(comparison);
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" }));
    await waitFor(() => expect(api.applyMatterBrief).toHaveBeenCalledWith("project", "proposal"));
});
it("resets both confirmations on close/reopen, restoration and preparing a different proposal", async () => {
    api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" });
    await open(); await screen.findByText(row.text); approveDisplayedProposal();
    expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeEnabled();
    fireEvent.click(within(screen.getByRole("dialog").querySelector("footer")!).getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume matter" })); await screen.findByText(row.text);
    expect(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /I compared the current brief/ })).not.toBeChecked();
    approveDisplayedProposal(); fireEvent.click(screen.getByRole("button", { name: "Prepare a different proposal" }));
    api.proposeMatterBrief.mockResolvedValue({ ...proposal, id: "different-proposal" });
    fireEvent.click(screen.getByRole("checkbox", { name: /message1.docx/ }));
    fireEvent.change(screen.getByLabelText("Configured model ID"), { target: { value: "mock-model" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Send only the current brief/ }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare proposed update" })); await screen.findByText(row.text);
    expect(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /I compared the current brief/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeDisabled(); expect(api.applyMatterBrief).not.toHaveBeenCalled();
});
it("resets both confirmations when navigation restores another project's proposal", async () => {
    api.getMatterBrief.mockImplementation(async (project: string) => contextState(project, true));
    api.getMatterBriefProposal.mockImplementation(async (project: string) => contextProposal(project));
    const view = render(<ReviewedMatterBrief projectId="matter-a" onApplied={onApplied}/>);
    fireEvent.click(screen.getByRole("button", { name: "Resume matter" })); await screen.findByText("matter-a proposed position"); approveDisplayedProposal();
    view.rerender(<ReviewedMatterBrief projectId="matter-b" onApplied={onApplied}/>); await screen.findByText("matter-b proposed position");
    expect(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /I compared the current brief/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Apply reviewed update" })).toBeDisabled(); expect(api.applyMatterBrief).not.toHaveBeenCalled();
});
it("ignores a previous project's post-Apply refresh after navigation", async () => {
    const refresh = deferred<ReturnType<typeof contextState>>(); let aReads = 0;
    api.getMatterBrief.mockImplementation((project: string) => project === "matter-a" && ++aReads > 1 ? refresh.promise : Promise.resolve(contextState(project, project === "matter-a")));
    api.getMatterBriefProposal.mockResolvedValue(contextProposal("matter-a"));
    const view = render(<ReviewedMatterBrief projectId="matter-a" onApplied={onApplied}/>);
    fireEvent.click(screen.getByRole("button", { name: "Resume matter" })); await screen.findByText("matter-a proposed position"); approveDisplayedProposal();
    fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" })); await waitFor(() => expect(aReads).toBe(2));
    view.rerender(<ReviewedMatterBrief projectId="matter-b" onApplied={onApplied}/>); await screen.findByRole("link", { name: "Open current brief: matter-b-brief.docx" });
    await act(async () => { refresh.resolve(contextState("matter-a")); });
    expect(screen.getByRole("link", { name: "Open current brief: matter-b-brief.docx" })).toBeInTheDocument();
    expect(screen.queryByText(/A new brief version and the source-review checkpoint/)).not.toBeInTheDocument(); expect(onApplied).not.toHaveBeenCalled();
});

it.each(["resolve", "reject"])("ignores an old preparation %s without clearing the new project's busy state", async outcome => {
    const old = deferred<typeof proposal>(), current = deferred<typeof proposal>();
    api.getMatterBrief.mockImplementation(async (project: string) => contextState(project));
    api.proposeMatterBrief.mockImplementation((project: string) => project === "matter-a" ? old.promise : current.promise);
    const view = render(<ReviewedMatterBrief projectId="matter-a" onApplied={onApplied}/>);
    fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    async function prepare(project: string) {
        await screen.findByRole("link", { name: `Open current brief: ${project}-brief.docx` });
        fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(project + "-source.docx") }));
        fireEvent.change(screen.getByLabelText("Configured model ID"), { target: { value: "mock-model" } });
        fireEvent.click(screen.getByRole("checkbox", { name: /Send only the current brief/ }));
        fireEvent.click(screen.getByRole("button", { name: "Prepare proposed update" }));
        await waitFor(() => expect(api.proposeMatterBrief).toHaveBeenCalledWith(project, [project + "-source"], "mock-model"));
    }
    await prepare("matter-a"); view.rerender(<ReviewedMatterBrief projectId="matter-b" onApplied={onApplied}/>); await prepare("matter-b");
    await act(async () => { if (outcome === "resolve") old.resolve(contextProposal("matter-a")); else old.reject(new Error("Fictional old-project preparation failure")); });
    expect(within(screen.getByRole("dialog").querySelector("footer")!).getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /matter-b-source.docx/ })).toBeDisabled();
    expect(screen.queryByText("matter-a proposed position")).not.toBeInTheDocument(); expect(notifyError).not.toHaveBeenCalled();
    await act(async () => { current.resolve(contextProposal("matter-b")); }); await screen.findByText("matter-b proposed position");
    expect(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /I compared the current brief/ })).not.toBeChecked();
    expect(api.applyMatterBrief).not.toHaveBeenCalled();
});

it("recovers a committed designation with a read retry instead of leaving the old designation form enabled", async () => {
    const doc = source("candidate");
    api.getMatterBrief.mockResolvedValueOnce({ ...state, brief: null, sources: [doc] }).mockRejectedValueOnce(new Error("Fictional designation reload failure")).mockResolvedValue({ ...state, brief: doc });
    render(<ReviewedMatterBrief projectId="project" onApplied={onApplied}/>);
    fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    fireEvent.change(await screen.findByLabelText("Brief document"), { target: { value: doc.documentId } });
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand updates to this brief/ }));
    fireEvent.click(screen.getByRole("button", { name: "Designate brief" }));
    await waitFor(() => expect(api.designateMatterBrief).toHaveBeenCalledWith("project", doc.documentId));
    await screen.findByText(/Brief designated.*could not/);
    expect(screen.queryByRole("button", { name: "Designate brief" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry loading brief" }));
    await screen.findByRole("link", { name: "Open current brief: candidate.docx" });
    expect(api.designateMatterBrief).toHaveBeenCalledTimes(1); expect(api.proposeMatterBrief).not.toHaveBeenCalled(); expect(api.applyMatterBrief).not.toHaveBeenCalled();
});
it("retries a failed pending-proposal read in place without inviting generation or losing the inventory", async () => {
    api.getMatterBrief.mockResolvedValue({ ...state, pendingProposalId: "proposal" });
    api.getMatterBriefProposal.mockRejectedValueOnce(new Error("Fictional pending proposal read failure")).mockResolvedValue(proposal);
    await open();
    const retry = await screen.findByRole("button", { name: "Retry saved proposal" });
    expect(screen.queryByRole("button", { name: "Prepare proposed update" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Outstanding sources (3)" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /scan.pdf/ }).closest("label")).toHaveTextContent("Text extraction is not ready");
    fireEvent.click(retry); await screen.findByText(row.text);
    expect(api.getMatterBriefProposal).toHaveBeenCalledTimes(2); expect(api.proposeMatterBrief).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox", { name: /I reviewed this proposed text/ })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: /I compared the current brief/ })).not.toBeChecked();
});
it("loads the pending proposal when retrying an initially failed brief read", async () => {
    api.getMatterBrief.mockRejectedValueOnce(new Error("Fictional initial read failure")).mockResolvedValue({ ...state, pendingProposalId: "proposal" });
    render(<ReviewedMatterBrief projectId="project" onApplied={onApplied}/>); fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry loading brief" })); await screen.findByText(row.text);
    expect(api.getMatterBriefProposal).toHaveBeenCalledWith("project", "proposal"); expect(api.proposeMatterBrief).not.toHaveBeenCalled();
});
it.each([false, true])("attempts the document refresh after an Apply-success brief reload failure (document refresh fails=%s)", async documentFails => {
    api.getMatterBrief.mockResolvedValueOnce({ ...state, pendingProposalId: "proposal" }).mockRejectedValueOnce(new Error("Fictional post-Apply brief reload failure"));
    if (documentFails) onApplied.mockRejectedValueOnce(new Error("Fictional independent document refresh failure"));
    await open(); await screen.findByText(row.text); approveDisplayedProposal(); fireEvent.click(screen.getByRole("button", { name: "Apply reviewed update" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(api.applyMatterBrief).toHaveBeenCalledTimes(1); expect(screen.queryByText("Proposed update — not applied")).not.toBeInTheDocument();
    expect(screen.getByText(documentFails ? /Applied.*brief view and document list could not refresh/ : /Applied.*brief view could not refresh/)).toBeInTheDocument();
});
it("offers only actual DOCX types for designation while retaining every other source in the inventory", async () => {
    const documents = [source("typed-docx"), { ...source("upper-docx"), fileType: "DoCx" }, { ...source("mime-docx"), filename: "actual-type.pdf", fileType: "APPLICATION/VND.OPENXMLFORMATS-OFFICEDOCUMENT.WORDPROCESSINGML.DOCUMENT" }, { ...source("pdf"), filename: "misleading.docx", fileType: "pdf" }, { ...source("unknown"), fileType: undefined }, { ...source("null-type"), fileType: null }, { ...source("padded"), fileType: " docx " }];
    api.getMatterBrief.mockResolvedValueOnce({ ...state, brief: null, sources: documents }).mockResolvedValue({ ...state, brief: documents[0], sources: documents.slice(1) });
    render(<ReviewedMatterBrief projectId="project" onApplied={onApplied}/>); fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    const chooser = await screen.findByLabelText("Brief document");
    expect(within(chooser).getAllByRole("option").map(option => option.textContent)).toEqual(["Select a DOCX", "typed-docx.docx", "upper-docx.docx", "actual-type.pdf"]);
    fireEvent.change(chooser, { target: { value: "typed-docx" } }); fireEvent.click(screen.getByRole("checkbox", { name: /I understand updates to this brief/ }));
    fireEvent.click(screen.getByRole("button", { name: "Designate brief" })); await screen.findByRole("heading", { name: "Outstanding sources (6)" });
    for (const doc of documents.slice(1)) expect(screen.getByRole("checkbox", { name: new RegExp(doc.filename.replaceAll(".", "\\.")) })).toBeInTheDocument();
});

it("ignores a late saved-proposal retry after navigation to another project", async () => {
    const pending = deferred<typeof proposal>(); let aReads = 0;
    api.getMatterBrief.mockImplementation(async (project: string) => contextState(project, project === "matter-a"));
    api.getMatterBriefProposal.mockImplementation((project: string) => project === "matter-a" && ++aReads === 1 ? Promise.reject(new Error("Fictional initial proposal read failure")) : pending.promise);
    const view = render(<ReviewedMatterBrief projectId="matter-a" onApplied={onApplied}/>); fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved proposal" })); await waitFor(() => expect(aReads).toBe(2));
    view.rerender(<ReviewedMatterBrief projectId="matter-b" onApplied={onApplied}/>); await screen.findByRole("link", { name: "Open current brief: matter-b-brief.docx" });
    await act(async () => { pending.resolve(contextProposal("matter-a")); });
    expect(screen.queryByText("matter-a proposed position")).not.toBeInTheDocument(); expect(screen.queryByRole("region", { name: "Saved proposal recovery" })).not.toBeInTheDocument();
    expect(api.proposeMatterBrief).not.toHaveBeenCalled(); expect(api.applyMatterBrief).not.toHaveBeenCalled();
});
it("does not let a previous project's designation reload affect the new project", async () => {
    const reload = deferred<typeof state>(); let aReads = 0;
    api.getMatterBrief.mockImplementation((project: string) => project === "matter-a" ? (++aReads === 1 ? Promise.resolve({ ...state, brief: null, sources: [source("candidate")] }) : reload.promise) : Promise.resolve(contextState(project)));
    const view = render(<ReviewedMatterBrief projectId="matter-a" onApplied={onApplied}/>); fireEvent.click(screen.getByRole("button", { name: "Resume matter" }));
    fireEvent.change(await screen.findByLabelText("Brief document"), { target: { value: "candidate" } }); fireEvent.click(screen.getByRole("checkbox", { name: /I understand updates to this brief/ })); fireEvent.click(screen.getByRole("button", { name: "Designate brief" }));
    await waitFor(() => expect(aReads).toBe(2));
    expect(screen.queryByRole("button", { name: "Designate brief" })).not.toBeInTheDocument();
    view.rerender(<ReviewedMatterBrief projectId="matter-b" onApplied={onApplied}/>); await screen.findByRole("link", { name: "Open current brief: matter-b-brief.docx" });
    const errorsBefore = vi.mocked(notifyError).mock.calls.length;
    await act(async () => { reload.reject(new Error("Fictional late designation reload failure")); });
    expect(screen.getByRole("link", { name: "Open current brief: matter-b-brief.docx" })).toBeInTheDocument();
    expect(screen.queryByText(/Brief designated/)).not.toBeInTheDocument(); expect(notifyError).toHaveBeenCalledTimes(errorsBefore);
    expect(api.designateMatterBrief).toHaveBeenCalledWith("matter-a", "candidate"); expect(api.designateMatterBrief).toHaveBeenCalledTimes(1);
});
