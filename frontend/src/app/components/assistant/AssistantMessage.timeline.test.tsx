import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

// Settings > Features > Response details, off unless a test turns it on.
const profileState = vi.hoisted(() => ({ responseDetailsVisible: false }));
vi.mock("@/app/contexts/UserProfileContext", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/contexts/UserProfileContext")>()),
    useOptionalUserProfile: () => ({
        profile: { responseDetailsVisible: profileState.responseDetailsVisible },
    }),
}));

afterEach(() => {
    profileState.responseDetailsVisible = false;
});

const approvalRequest: AssistantEvent = {
    type: "ask_inputs",
    event_id: "ask-1",
    items: [
        {
            id: "approve-1",
            kind: "approval",
            connector_name: "Gmail",
            tool_name: "gmail_send",
            title: "Send email",
            arguments: { to: ["a@example.com"], subject: "Hi", body: "Body" },
            binding: { type: "google", provider: "gmail", grant_id: "g1" },
        },
    ],
};

const reasoning = (text: string): AssistantEvent => ({
    type: "reasoning",
    text,
});

describe("AssistantMessage timeline", () => {
    it("places read-only text cards between surrounding prose, outside collapsed activity", () => {
        render(<AssistantMessage events={[
            { type: "content", text: "Here is your draft." },
            reasoning("Preparing the wording."),
            { type: "text_card", card_id: "card-1", title: "Email", text: "Dear Alex," },
            { type: "content", text: "You can also use this version." },
            { type: "text_card", card_id: "card-2", title: "Alternative", text: "Hello Alex," },
            { type: "content", text: "Adjust the greeting." },
        ]} />);
        const ordered = [screen.getByText("Here is your draft."), screen.getByRole("region", { name: "Email" }), screen.getByText("You can also use this version."), screen.getByRole("region", { name: "Alternative" }), screen.getByText("Adjust the greeting.")];
        ordered.forEach((element, index) => {
            expect(element).toBeVisible();
            if (index) expect(ordered[index - 1].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });
        expect(screen.queryByRole("textbox")).toBeNull();
    });
    beforeEach(() => {
        vi.stubGlobal("ResizeObserver", class {
            observe() {}
            disconnect() {}
        });
    });
    afterEach(() => vi.unstubAllGlobals());
    it("hides the copy button while it waits for input or approval", () => {
        const { rerender } = render(
            <AssistantMessage events={[approvalRequest]} awaitingInput />,
        );

        // Nothing has been delivered yet, so there is nothing to copy.
        expect(
            screen.queryByRole("button", { name: "Copy response" }),
        ).toBeNull();

        // Once the request is settled the message is an ordinary one again.
        rerender(<AssistantMessage events={[approvalRequest]} />);
        expect(
            screen.getByRole("button", { name: "Copy response" }),
        ).toBeInTheDocument();
    });

    it("folds a run of reasoning events into one thinking block", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("First I check the parties."),
                    reasoning("Then the termination clause."),
                    reasoning("Finally the governing law."),
                ]}
            />,
        );

        // One block, not three stacked on the timeline.
        const toggles = screen.getAllByRole("button", {
            name: /Thought process/,
        });
        expect(toggles).toHaveLength(1);

        fireEvent.click(toggles[0]);
        expect(screen.getByText(/First I check the parties/)).toBeVisible();
        expect(screen.getByText(/Then the termination clause/)).toBeVisible();
        expect(screen.getByText(/Finally the governing law/)).toBeVisible();
    });

    it("keeps reasoning separated by other work in its own blocks", () => {
        render(
            <AssistantMessage
                events={[
                    reasoning("Before the search."),
                    {
                        type: "doc_read",
                        filename: "lease.pdf",
                        document_id: "d1",
                        version_id: "v1",
                        version_number: 1,
                    },
                    reasoning("After the search."),
                ]}
            />,
        );

        expect(
            screen.getAllByRole("button", { name: /Thought process/ }),
        ).toHaveLength(2);
    });

    it("does not mark the response failed when a single tool call fails", () => {
        const { container } = render(
            <AssistantMessage
                events={[
                    {
                        type: "mcp_tool_call",
                        connector_id: "c1",
                        connector_name: "Drive",
                        tool_name: "search",
                        openai_tool_name: "drive_search",
                        status: "error",
                        error: "Connector unavailable",
                    },
                    { type: "content", text: "Here is what I found anyway." },
                ]}
            />,
        );

        // The response is not branded an error…
        expect(
            screen.queryByText("Sorry, something went wrong."),
        ).not.toBeInTheDocument();

        // …while the failed step still reports itself once the steps are open.
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(container.querySelector(".bg-red-400")).not.toBeNull();
        expect(screen.getByText("Connector unavailable")).toBeInTheDocument();
    });

    it("marks a successful connector call green and a failed one red", () => {
        const call = (status: "ok" | "error"): AssistantEvent => ({
            type: "mcp_tool_call",
            connector_id: "c1",
            connector_name: "Drive",
            tool_name: "search",
            openai_tool_name: "drive_search",
            status,
            ...(status === "error" ? { error: "Connector unavailable" } : {}),
        });
        const { container, unmount } = render(
            <AssistantMessage
                events={[call("ok"), { type: "content", text: "Found it." }]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(container.querySelector(".bg-green-400")).not.toBeNull();
        expect(container.querySelector(".bg-red-400")).toBeNull();
        expect(container.querySelector(".bg-gray-500")).toBeNull();
        // The connector step carries a decorative svg icon beside its label.
        const icon = screen.getByTestId("connector-event-icon");
        expect(icon.getAttribute("src")).toContain(
            "/icons/features/connector.svg",
        );
        expect(icon).toHaveAttribute("aria-hidden", "true");
        expect(icon.parentElement).toHaveTextContent("Drive: Search");
        unmount();

        const failed = render(
            <AssistantMessage
                events={[call("error"), { type: "content", text: "Sorry." }]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 1 step" }),
        );
        expect(failed.container.querySelector(".bg-red-400")).not.toBeNull();
        expect(failed.container.querySelector(".bg-green-400")).toBeNull();
    });

    it("keeps a pending connector approval open in the assistant flow", () => {
        render(<AssistantMessage events={[approvalRequest]} />);

        expect(screen.getByText("Asking for approval")).toBeVisible();
        expect(screen.getByText("Gmail: Send email")).toBeVisible();
    });

    it("records the decision and the approved action's result", () => {
        render(
            <AssistantMessage
                events={[
                    approvalRequest,
                    {
                        type: "ask_inputs_response",
                        assistant_message_id: "m1",
                        ask_event_id: "ask-1",
                        responses: [
                            {
                                id: "approve-1",
                                kind: "approval",
                                decision: "approve",
                            },
                        ],
                    },
                    {
                        type: "mcp_tool_call",
                        connector_id: "gmail-native",
                        connector_name: "Gmail",
                        tool_name: "gmail_send",
                        openai_tool_name: "gmail_send",
                        status: "ok",
                        approval_id: "approve-1",
                    },
                    { type: "content", text: "Sent." },
                ]}
            />,
        );

        fireEvent.click(
            screen.getByRole("button", { name: "Completed in 2 steps" }),
        );
        fireEvent.click(screen.getByText("Asked for approval"));
        expect(screen.getByText("Approved")).toBeVisible();
        expect(screen.getByText("Gmail: Gmail send")).toBeVisible();
    });

    it("marks the response failed for a top-level error event", () => {
        render(
            <AssistantMessage
                events={[
                    {
                        type: "error",
                        message: "The response was interrupted.",
                        safe_to_display: true,
                    } as AssistantEvent,
                ]}
            />,
        );

        expect(
            screen.getByText("The response was interrupted."),
        ).toBeInTheDocument();
    });

    describe("subagents", () => {
        const delegation = (
            overrides: Partial<Extract<AssistantEvent, { type: "delegation" }>> = {},
        ): AssistantEvent => ({
            type: "delegation",
            delegation_id: "d1",
            title: "Review the lease",
            task: "List every rent review clause in lease.pdf.",
            status: "completed",
            brief: "Clause 4.2 sets an annual review.",
            events: [
                { type: "doc_read", filename: "lease.pdf" },
                { type: "case_citation", cluster_id: 1, case_name: null, citation: null, url: "" },
            ],
            model: "claude-haiku-4-5",
            effort: "standard",
            usage: { input_tokens: 1000, output_tokens: 200 },
            ...overrides,
        });
        const second = delegation({ delegation_id: "d2", title: "Check the guarantee" });
        const openTimeline = (label = "Completed in 1 step · 1 subagent") =>
            fireEvent.click(screen.getByRole("button", { name: label }));
        const pill = (title: RegExp | string) =>
            within(screen.getByRole("group", { name: "Subagents" })).getByRole("button", {
                name: typeof title === "string" ? new RegExp(`^${title}`) : title,
            });
        const hasConnector = (text: string) =>
            !!screen
                .getByText(text)
                .closest("div.relative")
                ?.querySelector(':scope > [data-slot="event-connector"]');

        it("shows Mike starting the subagents, one pill each, with Mike's line running past them", () => {
            render(
                <AssistantMessage
                    events={[
                        { type: "doc_read", filename: "brief.pdf" },
                        delegation(),
                        second,
                        { type: "doc_read", filename: "summary.pdf" },
                        { type: "content", text: "Done." },
                    ]}
                />,
            );
            openTimeline("Completed in 3 steps · 2 subagents");

            expect(screen.getByText("Started 2 subagents")).toBeVisible();
            expect(pill("Review the lease")).toHaveAttribute("aria-pressed", "false");
            expect(pill("Check the guarantee")).toBeVisible();
            expect(screen.getByText("2 subagents finished")).toBeVisible();
            // Mike's line runs through "Started", beside the card, and on from
            // "finished" to Mike's next step.
            expect(hasConnector("brief.pdf")).toBe(true);
            expect(hasConnector("Started 2 subagents")).toBe(true);
            expect(hasConnector("2 subagents finished")).toBe(true);
            // A subagent's steps stay hidden until its pill is selected, and
            // one subagent's details show at a time.
            expect(screen.queryByText("lease.pdf")).toBeNull();
            fireEvent.click(pill("Review the lease"));
            expect(pill("Review the lease")).toHaveAttribute("aria-pressed", "true");
            expect(screen.getByRole("region", { name: "Review the lease" })).toHaveTextContent("lease.pdf");
            fireEvent.click(pill("Check the guarantee"));
            expect(screen.queryByRole("region", { name: "Review the lease" })).toBeNull();
            expect(screen.getByRole("region", { name: "Check the guarantee" })).toBeVisible();
            fireEvent.click(pill("Check the guarantee"));
            expect(screen.queryByRole("region", { name: "Check the guarantee" })).toBeNull();
        });

        it("shows a selected subagent's status, the task from Mike, its steps and its brief", () => {
            render(<AssistantMessage events={[delegation(), { type: "content", text: "Done." }]} />);
            openTimeline();
            fireEvent.click(pill("Review the lease"));

            expect(screen.getByRole("region", { name: "Review the lease" })).toHaveTextContent("Completed in 1 step");
            // The pill names the subagent; its details don't repeat the title.
            expect(screen.getAllByText("Review the lease")).toHaveLength(1);
            // The model, reasoning and tokens stay hidden until the user asks for them.
            expect(screen.queryByText(/budget allocated/)).toBeNull();
            expect(screen.queryByText(/List every rent review clause/)).toBeNull();
            fireEvent.click(screen.getByRole("button", { name: "Task from Mike" }));
            expect(screen.getByText(/List every rent review clause/)).toBeVisible();
            expect(screen.getByText("lease.pdf")).toBeVisible();

            fireEvent.click(screen.getByRole("button", { name: "Returned a brief to Mike" }));
            expect(screen.getByRole("region", { name: "Brief" }))
                .toHaveTextContent("Clause 4.2 sets an annual review.");
        });

        it("shows a subagent's model, reasoning, tokens and budget at the bottom of its details when asked to", () => {
            profileState.responseDetailsVisible = true;
            render(
                <AssistantMessage
                    events={[
                        delegation({ reasoning: "low", token_budget: 2_500_000 }),
                        { type: "content", text: "Done." },
                    ]}
                />,
            );
            openTimeline();
            fireEvent.click(pill("Review the lease"));

            const details = screen.getByText(/ \(Low\): 1.2K tokens \(2.5M budget allocated\)$/);
            const region = screen.getByRole("region", { name: "Review the lease" });
            expect(region.lastElementChild).toBe(details);
            expect(
                screen.getByText("Completed in 1 step", { selector: "p" }),
            ).not.toHaveTextContent("tokens");
        });

        it("leaves out what an older subagent run did not record", () => {
            profileState.responseDetailsVisible = true;
            render(<AssistantMessage events={[delegation(), { type: "content", text: "Done." }]} />);
            openTimeline();
            fireEvent.click(pill("Review the lease"));
            const details = screen.getByText(/: 1.2K tokens$/);
            expect(details).not.toHaveTextContent("(");
        });

        it.each([
            ["connects the last step to the brief", {}, true],
            ["leaves the last step unconnected without a brief", { brief: undefined }, false],
        ])("%s", (_name, overrides, connected) => {
            render(<AssistantMessage events={[delegation(overrides), { type: "content", text: "Done." }]} />);
            openTimeline();
            fireEvent.click(pill("Review the lease"));
            expect(hasConnector("lease.pdf")).toBe(connected);
        });

        it.each([
            [{}, "Completed in 1 step"],
            [{ status: "incomplete" as const }, "Stopped at its limit · partial brief · 1 step"],
            [{ status: "cancelled" as const }, "Stopped · 1 step"],
            [{ status: "failed" as const }, "Couldn't finish"],
            [{ status: "needs_input" as const, question: "Which lease?" }, "Asked Mike a question · 1 step"],
            [{ status: "needs_input" as const, approval_ids: ["approve-1"] }, "Waiting for your approval · 1 step"],
            [{ continued_from: "d0" }, "Resumed · Completed in 1 step"],
        ])("reports how the subagent ended, with its pill and in its details", (overrides, status) => {
            render(<AssistantMessage events={[delegation(overrides), { type: "content", text: "Done." }]} />);
            openTimeline();
            expect(pill("Review the lease")).toHaveAccessibleName(`Review the lease, ${status}`);
            fireEvent.click(pill("Review the lease"));
            expect(screen.getByRole("region", { name: "Review the lease" })).toHaveTextContent(status);
        });

        it.each([
            [[delegation({ continued_from: "d0" })], "Resumed a subagent"],
            [[delegation({ continued_from: "d0" }), second], "Started 1 and resumed 1 subagents"],
        ])("says when Mike resumed a subagent", (delegations, label) => {
            render(<AssistantMessage events={[...delegations, { type: "content", text: "Done." }]} />);
            openTimeline(`Completed in 1 step · ${delegations.length} subagent${delegations.length === 1 ? "" : "s"}`);
            expect(screen.getByText(label)).toBeVisible();
        });

        it("shows the question a paused subagent asked Mike", () => {
            render(
                <AssistantMessage
                    events={[
                        delegation({ status: "needs_input", question: "Which lease, the 2019 or the 2021 one?" }),
                        { type: "content", text: "Done." },
                    ]}
                />,
            );
            openTimeline();
            fireEvent.click(pill("Review the lease"));
            expect(screen.getByText("Asked Mike")).toBeVisible();
            expect(screen.getByText("Which lease, the 2019 or the 2021 one?")).toBeVisible();
        });

        it("shows a running subagent's activity and holds Mike's line until every subagent finishes", () => {
            render(
                <AssistantMessage
                    isStreaming
                    events={[
                        delegation({ isStreaming: true, activity: "read_document", events: [] }),
                        second,
                    ]}
                />,
            );
            expect(pill("Review the lease")).toHaveAccessibleName("Review the lease, Running · Reading document...");
            expect(screen.queryByText("2 subagents finished")).toBeNull();
            expect(hasConnector("Started 2 subagents")).toBe(false);
            fireEvent.click(pill("Review the lease"));
            expect(screen.getByText("Steps appear when the subagent finishes.")).toBeVisible();
        });

        const laneIcon = (title: string) => {
            const icon = screen
                .getByRole("button", { name: new RegExp(`^${title}`) })
                .querySelector<HTMLElement>('[data-slot="subagent-icon"]');
            const mark = icon?.firstElementChild as HTMLElement | null | undefined;
            return { tint: icon?.dataset.tint, spinning: mark?.style.animationPlayState === "running" };
        };

        it("gives each subagent its own coloured mark, turning only while it works", () => {
            render(
                <AssistantMessage
                    isStreaming
                    events={[delegation({ isStreaming: true, events: [] }), second]}
                />,
            );
            const running = laneIcon("Review the lease");
            const done = laneIcon("Check the guarantee");
            expect(running).toEqual({ tint: "sky", spinning: true });
            expect(done).toEqual({ tint: "violet", spinning: false });
        });

        it("marks a subagent that couldn't finish with the error mark", () => {
            const { container } = render(
                <AssistantMessage events={[delegation({ status: "failed" }), { type: "content", text: "Done." }]} />,
            );
            openTimeline();
            const fill = container.querySelector('[data-slot="subagent-icon"] linearGradient[id$="-m-glassFill"] stop');
            expect((fill as SVGStopElement).style.stopColor.replace(/\s/g, "")).toBe("rgb(248,113,113)");
        });

        it("keeps a subagent's colour when Mike resumes it later in the answer", () => {
            render(
                <AssistantMessage
                    events={[
                        delegation(),
                        second,
                        { type: "doc_read", filename: "notes.pdf" },
                        delegation({ delegation_id: "d3", continued_from: "d2", title: "Recheck the guarantee" }),
                        { type: "content", text: "Done." },
                    ]}
                />,
            );
            openTimeline("Completed in 3 steps · 3 subagents");
            expect(laneIcon("Check the guarantee").tint).toBe("violet");
            expect(laneIcon("Recheck the guarantee").tint).toBe("violet");
        });

        it("finds a nested citation check's cases among the subagent's own steps", () => {
            render(
                <AssistantMessage
                    events={[
                        delegation({
                            events: [
                                { type: "courtlistener_verify_citations", citation_count: 1, match_count: 1 },
                                { type: "case_citation", cluster_id: 7, case_name: "Roe v. Wade", citation: "410 U.S. 113", url: "" },
                            ],
                        }),
                        { type: "content", text: "Done." },
                    ]}
                />,
            );
            openTimeline();
            fireEvent.click(pill("Review the lease"));
            fireEvent.click(screen.getByRole("button", { name: /Verified 1 citation/ }));
            expect(screen.getByText("Roe v. Wade, 410 U.S. 113")).toBeVisible();
        });
    });
});

describe("AssistantMessage response details", () => {
    const answer = (): AssistantEvent[] => [
        { type: "content", text: "Here is the answer." },
        {
            type: "response_details",
            model: "gemini-3.8-flash",
            reasoning: "medium",
            usage: { input_tokens: 1200, output_tokens: 100 },
        },
    ];

    it("keeps what the answer ran on hidden by default", () => {
        render(<AssistantMessage events={answer()} />);
        expect(screen.getByText("Here is the answer.")).toBeVisible();
        expect(screen.queryByText(/tokens/)).toBeNull();
    });

    it("shows the model, reasoning and tokens beside the copy button when asked to", () => {
        profileState.responseDetailsVisible = true;
        render(<AssistantMessage events={answer()} />);
        const details = screen.getByText("Gemini 3.8 Flash (Medium): 1.3K tokens");
        expect(details.parentElement).toContainElement(
            screen.getByRole("button", { name: "Copy response" }),
        );
        // The details never open a timeline of their own.
        expect(screen.queryByRole("button", { name: /^Completed in/ })).toBeNull();
    });

    it("adds what the answer's subagents used between them", () => {
        profileState.responseDetailsVisible = true;
        const subagent = (id: string, input_tokens: number): AssistantEvent => ({
            type: "delegation",
            delegation_id: id,
            title: `Task ${id}`,
            task: "Review.",
            status: "completed",
            events: [],
            model: "claude-haiku-4-5",
            effort: "standard",
            usage: { input_tokens, output_tokens: 0 },
        });
        render(<AssistantMessage events={[subagent("d1", 400_000), subagent("d2", 208_000), ...answer()]} />);
        expect(
            screen.getByText("Main: Gemini 3.8 Flash (Medium): 1.3K tokens. Subagents total: 608K tokens."),
        ).toBeVisible();
    });

    it("waits for the answer to finish", () => {
        profileState.responseDetailsVisible = true;
        render(<AssistantMessage isStreaming events={answer()} />);
        expect(screen.queryByText(/1.3K tokens/)).toBeNull();
    });
});
