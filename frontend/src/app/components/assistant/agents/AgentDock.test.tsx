import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentDock } from "./AgentDock";
import type { ChatAgent } from "@/app/components/shared/types";

const agent = (over: Partial<ChatAgent> = {}): ChatAgent => ({
    id: "agent-1",
    title: null,
    agent_instruction: "check the indemnity clause",
    source_message_id: "msg-1",
    source_excerpt: "the indemnity clause",
    created_at: "2026-08-26T10:00:00Z",
    status: "empty",
    pending_proposals: 0,
    ...over,
});

function renderDock(
    agents: ChatAgent[],
    options?: {
        streamingIds?: string[];
        activeAgentId?: string | null;
    },
) {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    const onRerun = vi.fn();
    render(
        <AgentDock
            agents={agents}
            streamingIds={new Set(options?.streamingIds ?? [])}
            activeAgentId={options?.activeAgentId ?? null}
            onOpen={onOpen}
            onDismiss={onDismiss}
            onRerun={onRerun}
        />,
    );
    return { onOpen, onDismiss, onRerun };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("AgentDock", () => {
    it("renders nothing when no agents are assigned", () => {
        const { container } = render(
            <AgentDock
                agents={[]}
                streamingIds={new Set()}
                activeAgentId={null}
                onOpen={vi.fn()}
                onDismiss={vi.fn()}
                onRerun={vi.fn()}
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("shows one card per agent, labelled from its instruction", () => {
        renderDock([
            agent({ id: "a", agent_instruction: "check the indemnity clause" }),
            agent({ id: "b", agent_instruction: "find the counter-argument" }),
        ]);

        expect(screen.getAllByRole("listitem")).toHaveLength(2);
        expect(
            screen.getByRole("button", {
                name: "Open check the indemnity clause",
            }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Open find the counter-argument" }),
        ).toBeInTheDocument();
    });

    it("announces Processing while this client holds the stream open", () => {
        renderDock([agent({ id: "a", status: "empty" })], {
            streamingIds: ["a"],
        });

        expect(screen.getByText(/Processing/)).toBeInTheDocument();
        // A streaming agent is working, not stalled, so no rerun is offered.
        expect(
            screen.queryByRole("button", { name: /^Rerun/ }),
        ).not.toBeInTheDocument();
    });

    it("announces Ready once the server says an answer landed", () => {
        renderDock([agent({ id: "a", status: "ready" })]);
        expect(screen.getByText(/Ready/)).toBeInTheDocument();
    });

    it("offers a rerun for an agent that came back with no answer", async () => {
        const user = userEvent.setup();
        const { onRerun } = renderDock([agent({ id: "a", status: "empty" })]);

        expect(screen.getByText(/Needs rerun/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /^Rerun/ }));
        expect(onRerun).toHaveBeenCalledWith("a");
    });

    it("badges the number of proposed edits awaiting review", () => {
        renderDock([agent({ id: "a", status: "ready", pending_proposals: 3 })]);

        expect(
            screen.getByLabelText("3 proposed edits awaiting review"),
        ).toHaveTextContent("3");
    });

    it("uses the singular for a lone proposal, and hides the badge at zero", () => {
        const { container } = render(
            <>
                <AgentDock
                    agents={[agent({ id: "a", pending_proposals: 1 })]}
                    streamingIds={new Set()}
                    activeAgentId={null}
                    onOpen={vi.fn()}
                    onDismiss={vi.fn()}
                    onRerun={vi.fn()}
                />
            </>,
        );
        expect(
            screen.getByLabelText("1 proposed edit awaiting review"),
        ).toBeInTheDocument();
        expect(container.textContent).not.toContain("0 proposed");
    });

    it("marks the open agent's card as pressed", () => {
        renderDock([agent({ id: "a" }), agent({ id: "b" })], {
            activeAgentId: "b",
        });

        const pressed = screen
            .getAllByRole("button", { pressed: true })
            .map((node) => node.textContent);
        expect(pressed).toHaveLength(1);
    });

    it("opens a thread when the card is clicked", async () => {
        const user = userEvent.setup();
        const { onOpen } = renderDock([agent({ id: "a" })]);

        await user.click(
            screen.getByRole("button", {
                name: "Open check the indemnity clause",
            }),
        );
        expect(onOpen).toHaveBeenCalledWith("a");
    });

    it("dismisses an agent from its own card", async () => {
        const user = userEvent.setup();
        const { onDismiss } = renderDock([agent({ id: "a" })]);

        await user.click(screen.getByRole("button", { name: /^Dismiss/ }));
        expect(onDismiss).toHaveBeenCalledWith("a");
    });

    it("publishes every card's status to a live region", () => {
        renderDock(
            [
                agent({ id: "a", agent_instruction: "one", status: "ready" }),
                agent({ id: "b", agent_instruction: "two", status: "empty" }),
            ],
            { streamingIds: ["b"] },
        );

        const live = document.querySelector('[aria-live="polite"]');
        expect(live?.textContent).toBe("one: Ready. two: Processing");
    });
});
