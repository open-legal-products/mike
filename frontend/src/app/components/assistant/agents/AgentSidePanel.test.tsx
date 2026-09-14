import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSidePanel, type AgentPanelMode } from "./AgentSidePanel";
import type { AssistantEvent, Message } from "@/app/components/shared/types";

// The transcript renderer pulls in the whole message subsystem (markdown,
// citations, docx viewers). The panel's own behaviour is the assign form, the
// composer, and the proposal cards, so the renderer is stubbed down to its
// visible text.
vi.mock("@/app/components/assistant/AssistantMessage", () => ({
    AssistantMessage: ({ events }: { events?: AssistantEvent[] }) => (
        <div data-testid="assistant-message">
            {(events ?? [])
                .filter((event) => event.type === "content")
                .map((event) => (event as { text: string }).text)
                .join("")}
        </div>
    ),
}));

const proposal = (
    over: Partial<Extract<AssistantEvent, { type: "edit_proposal" }>> = {},
): AssistantEvent => ({
    type: "edit_proposal",
    proposal_id: "p1",
    target_excerpt: "the indemnity clause",
    replacement: "the indemnity and hold-harmless clause",
    reason: "Names both halves of the protection.",
    status: "pending",
    ...over,
});

const assistantWithProposal = (
    events: AssistantEvent[] = [
        { type: "content", text: "Here is a tighter version." },
        proposal(),
    ],
): Message => ({
    id: "agent-msg-1",
    role: "assistant",
    content: "Here is a tighter version.",
    events,
});

function renderPanel(
    mode: AgentPanelMode,
    props: Partial<React.ComponentProps<typeof AgentSidePanel>> = {},
) {
    const handlers = {
        onAssign: vi.fn(),
        onSend: vi.fn(),
        onRerun: vi.fn(),
        onResolveProposal: vi.fn(),
        onClose: vi.fn(),
    };
    render(<AgentSidePanel mode={mode} {...handlers} {...props} />);
    return handlers;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("AgentSidePanel — assign mode", () => {
    const assignMode: AgentPanelMode = {
        kind: "assign",
        excerpt: "the indemnity clause",
        sourceMessageId: "msg-1",
    };

    it("shows the highlighted excerpt it is about to assign", () => {
        renderPanel(assignMode);

        expect(
            screen.getByRole("heading", { name: "Assign to agent" }),
        ).toBeInTheDocument();
        expect(screen.getByText("the indemnity clause")).toBeInTheDocument();
    });

    it("cannot assign an empty instruction", () => {
        renderPanel(assignMode);
        expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
    });

    it("assigns the typed instruction", async () => {
        const user = userEvent.setup();
        const { onAssign } = renderPanel(assignMode);

        await user.type(
            screen.getByLabelText("What should this agent do?"),
            "  is this enforceable?  ",
        );
        await user.click(screen.getByRole("button", { name: "Assign" }));

        expect(onAssign).toHaveBeenCalledWith("is this enforceable?");
    });

    it("assigns on Enter, and keeps Shift+Enter for a new line", async () => {
        const user = userEvent.setup();
        const { onAssign } = renderPanel(assignMode);
        const field = screen.getByLabelText("What should this agent do?");

        await user.type(field, "line one{Shift>}{Enter}{/Shift}line two");
        expect(onAssign).not.toHaveBeenCalled();

        await user.type(field, "{Enter}");
        expect(onAssign).toHaveBeenCalledWith("line one\nline two");
    });

    it("surfaces the server's reason for refusing an assignment", () => {
        renderPanel(assignMode, {
            assignError: "You can run 6 agents on a response.",
        });

        expect(screen.getByRole("status")).toHaveTextContent(
            "You can run 6 agents on a response.",
        );
    });

    it("closes from the header", async () => {
        const user = userEvent.setup();
        const { onClose } = renderPanel(assignMode);

        await user.click(
            screen.getByRole("button", { name: "Close agent panel" }),
        );
        expect(onClose).toHaveBeenCalled();
    });
});

describe("AgentSidePanel — thread mode", () => {
    const threadMode: AgentPanelMode = {
        kind: "thread",
        agentId: "agent-1",
        label: "check the indemnity",
        excerpt: "the indemnity clause",
    };

    it("renders the agent's conversation", () => {
        renderPanel(threadMode, {
            messages: [
                { id: "u1", role: "user", content: "is this enforceable?" },
                assistantWithProposal(),
            ],
        });

        expect(screen.getByText("is this enforceable?")).toBeInTheDocument();
        expect(screen.getByTestId("assistant-message")).toHaveTextContent(
            "Here is a tighter version.",
        );
    });

    it("continues the thread from the composer", async () => {
        const user = userEvent.setup();
        const { onSend } = renderPanel(threadMode, {
            messages: [assistantWithProposal()],
        });

        await user.type(
            screen.getByLabelText("Message this agent"),
            "and the governing law?",
        );
        await user.click(screen.getByRole("button", { name: "Send" }));

        expect(onSend).toHaveBeenCalledWith("and the governing law?");
    });

    it("offers a rerun for an agent that never answered", async () => {
        const user = userEvent.setup();
        const { onRerun } = renderPanel(threadMode, { messages: [] });

        expect(
            screen.getByText("This agent has not answered yet."),
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Run it again" }));
        expect(onRerun).toHaveBeenCalled();
    });

    it("does not offer a rerun while the stream is still open", () => {
        renderPanel(threadMode, { messages: [], isStreaming: true });
        expect(
            screen.queryByRole("button", { name: "Run it again" }),
        ).not.toBeInTheDocument();
    });
});

describe("AgentSidePanel — proposal cards", () => {
    const threadMode: AgentPanelMode = {
        kind: "thread",
        agentId: "agent-1",
        label: "check the indemnity",
        excerpt: "the indemnity clause",
    };

    it("shows what the edit replaces and what it replaces it with", () => {
        renderPanel(threadMode, { messages: [assistantWithProposal()] });

        expect(screen.getByText("Proposed edit")).toBeInTheDocument();
        // Once in the panel header (the assigned region) and once on the card
        // as the text the edit replaces.
        expect(screen.getAllByText("the indemnity clause")).toHaveLength(2);
        expect(
            screen.getByText("the indemnity and hold-harmless clause"),
        ).toBeInTheDocument();
        expect(
            screen.getByText("Names both halves of the protection."),
        ).toBeInTheDocument();
    });

    it("accepts a proposal", async () => {
        const user = userEvent.setup();
        const { onResolveProposal } = renderPanel(threadMode, {
            messages: [assistantWithProposal()],
        });

        await user.click(screen.getByRole("button", { name: "Accept" }));

        expect(onResolveProposal).toHaveBeenCalledWith(
            expect.objectContaining({ proposal_id: "p1" }),
            "accepted",
        );
    });

    it("rejects a proposal", async () => {
        const user = userEvent.setup();
        const { onResolveProposal } = renderPanel(threadMode, {
            messages: [assistantWithProposal()],
        });

        await user.click(screen.getByRole("button", { name: "Reject" }));

        expect(onResolveProposal).toHaveBeenCalledWith(
            expect.objectContaining({ proposal_id: "p1" }),
            "rejected",
        );
    });

    it("says the region has changed instead of failing silently", () => {
        renderPanel(threadMode, {
            messages: [assistantWithProposal()],
            staleProposalIds: new Set(["p1"]),
        });

        expect(screen.getByRole("status")).toHaveTextContent(
            "This part has changed, so the edit no longer applies.",
        );
        // Accept is off, because there is nothing to apply it to. Reject stays
        // live so the card can still be cleared away.
        expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    });

    it("disables both actions while a resolution is in flight", () => {
        renderPanel(threadMode, {
            messages: [assistantWithProposal()],
            resolvingProposalIds: new Set(["p1"]),
        });

        expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    });

    it("replaces the actions with the outcome once resolved", () => {
        renderPanel(threadMode, {
            messages: [
                assistantWithProposal([proposal({ status: "accepted" })]),
            ],
        });

        expect(
            screen.getByText("Applied to the response."),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Accept" }),
        ).not.toBeInTheDocument();
    });

    it("marks a rejected proposal as rejected", () => {
        renderPanel(threadMode, {
            messages: [
                assistantWithProposal([proposal({ status: "rejected" })]),
            ],
        });

        expect(screen.getByText("Rejected.")).toBeInTheDocument();
    });

    it("shows a pure deletion as a deletion", () => {
        renderPanel(threadMode, {
            messages: [
                assistantWithProposal([
                    proposal({ replacement: "", reason: null }),
                ]),
            ],
        });

        expect(screen.getByText("(deleted)")).toBeInTheDocument();
    });
});
