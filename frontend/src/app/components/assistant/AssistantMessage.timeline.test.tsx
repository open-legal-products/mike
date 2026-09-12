import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { withIntl } from "@/test/withIntl";
import { AssistantMessage } from "./AssistantMessage";
import type { AssistantEvent } from "../shared/types";

const reasoning = (text: string): AssistantEvent => ({
    type: "reasoning",
    text,
});

describe("AssistantMessage timeline", () => {
    it("folds a run of reasoning events into one thinking block", () => {
        render(
            withIntl(
                <AssistantMessage
                    events={[
                        reasoning("First I check the parties."),
                        reasoning("Then the termination clause."),
                        reasoning("Finally the governing law."),
                    ]}
                />,
            ),
        );

        // One block, not three stacked on the timeline.
        const toggles = screen.getAllByRole("button", {
            name: /Processo de raciocínio/,
        });
        expect(toggles).toHaveLength(1);

        fireEvent.click(toggles[0]);
        expect(screen.getByText(/First I check the parties/)).toBeVisible();
        expect(screen.getByText(/Then the termination clause/)).toBeVisible();
        expect(screen.getByText(/Finally the governing law/)).toBeVisible();
    });

    it("keeps reasoning separated by other work in its own blocks", () => {
        render(
            withIntl(
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
            ),
        );

        expect(
            screen.getAllByRole("button", { name: /Processo de raciocínio/ }),
        ).toHaveLength(2);
    });

    it("does not mark the response failed when a single tool call fails", () => {
        const { container } = render(
            withIntl(
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
            ),
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

    it("marks the response failed for a top-level error event", () => {
        render(
            withIntl(
                <AssistantMessage
                    events={[
                        {
                            type: "error",
                            message: "The response was interrupted.",
                            safe_to_display: true,
                        } as AssistantEvent,
                    ]}
                />,
            ),
        );

        expect(
            screen.getByText("The response was interrupted."),
        ).toBeInTheDocument();
    });
});
