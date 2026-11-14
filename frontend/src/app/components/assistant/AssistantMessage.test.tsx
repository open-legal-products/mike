import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@mike/ui";
import { AssistantMessage } from "./AssistantMessage";

describe("AssistantMessage copy", () => {
    beforeEach(() => clearToasts());

    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("tells the user when the clipboard refuses the copy", async () => {
        const user = userEvent.setup();
        // jsdom has no ClipboardItem; give the handler one so the failure
        // under test is the clipboard write itself, as it is in a browser.
        vi.stubGlobal(
            "ClipboardItem",
            class {
                constructor(public items: Record<string, Blob>) {}
            },
        );
        const write = vi
            .fn()
            .mockRejectedValue(
                new DOMException("Write permission denied.", "NotAllowedError"),
            );
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { ...navigator.clipboard, write },
        });

        render(
            <>
                <AssistantMessage
                    events={[{ type: "content", text: "The answer." }]}
                />
                <ToastViewportUI />
            </>,
        );

        await user.click(screen.getByRole("button", { name: "Copy response" }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't copy this answer");
        expect(alert).toHaveTextContent("clipboard permission");
        expect(alert).not.toHaveTextContent("Write permission denied.");
        expect(
            screen.queryByRole("button", { name: "Response copied" }),
        ).not.toBeInTheDocument();
        vi.unstubAllGlobals();
    });
});

describe("AssistantMessage web sources", () => {
    it("lists a page cited by several steps once, keeping its title", async () => {
        const user = userEvent.setup();
        render(
            <AssistantMessage
                events={[
                    {
                        type: "web_sources",
                        sources: [{ url: "https://law.test/s172" }],
                    },
                    { type: "content", text: "The answer." },
                    {
                        type: "web_sources",
                        sources: [
                            { url: "https://law.test/s172", title: "Section 172" },
                            { url: "https://law.test/s171", title: "Section 171" },
                        ],
                    },
                ]}
            />,
        );

        const toggle = screen.getByRole("button", { name: /Sources/ });
        expect(toggle).toHaveTextContent("2 web pages");
        await user.click(toggle);
        expect(screen.getByText("Section 172")).toBeInTheDocument();
    });
});

describe("AssistantMessage source links", () => {
    const mcp = (overrides: Record<string, unknown> = {}) =>
        ({
            type: "mcp_tool_call",
            connector_id: "counterpedia",
            connector_name: "Counterpedia",
            tool_name: "counterpedia.get_source_presence",
            openai_tool_name: "counterpedia_get_source_presence",
            status: "ok",
            ...overrides,
        }) as never;

    it("renders the exact structured source identity and URL", () => {
        render(
            <AssistantMessage
                events={[
                    { type: "content", text: "SEC filing" },
                    mcp({
                        source_links: [{
                            source_id: "TH-S01-SRC-0001",
                            label: "SEC enforcement filing",
                            url: "https://www.sec.gov/litigation/complaints/2018/comp-pr2018-41-theranos-holmes.pdf",
                            basis: "capture_observation",
                        }],
                    }),
                ]}
            />,
        );
        const link = screen.getByRole("link", { name: "SEC enforcement filing" });
        expect(link).toHaveAttribute("href", "https://www.sec.gov/litigation/complaints/2018/comp-pr2018-41-theranos-holmes.pdf");
        expect(screen.getByText("(TH-S01-SRC-0001)")).toBeInTheDocument();
    });

    it("does not let model text relabel or supply a missing source URL", () => {
        render(
            <AssistantMessage
                events={[
                    { type: "content", text: "[Ninth Circuit](https://evil.example/fake)" },
                    mcp({ source_links: [] }),
                ]}
            />
        );
        expect(screen.queryByRole("link", { name: "Ninth Circuit" })).toBeNull();
        expect(screen.getAllByText("Source link not established.").length).toBeGreaterThan(0);
    });

    it("keeps the Ninth Circuit source identity paired with its recorded URL", () => {
        render(
            <AssistantMessage
                events={[{ type: "content", text: "[SEC filing](https://www.sec.gov/litigation/complaints/2018/comp18200.htm) and [SEC renamed](https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/22/22-10312.pdf)" }, mcp({
                    source_links: [{
                        source_id: "TH-S09-SRC-0001",
                        label: "Ninth Circuit Order and Amended Opinion (captured public document)",
                        url: "https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/22/22-10312.pdf",
                        basis: "capture_observation",
                    }],
                })]}
            />,
        );
        const link = screen.getByRole("link", { name: /Amended Opinion/ });
        expect(link).toHaveAttribute("href", "https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/22/22-10312.pdf");
        expect(screen.getByText("(TH-S09-SRC-0001)")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "SEC filing" })).toBeNull();
        expect(screen.queryByRole("link", { name: "SEC renamed" })).toBeNull();
        expect(screen.getByText(/Recorded capture origin/)).toBeInTheDocument();
    });

    it("shows the refusal for the historical SEC source-list-only turn", () => {
        const invented = "https://www.sec.gov/litigation/complaints/2018/comp18200.htm";
        render(<AssistantMessage events={[
            mcp({ tool_name: "counterpedia.sources" }),
            { type: "content", text: `[SEC original](${invented})` },
        ]} />);
        expect(screen.queryByRole("link")).toBeNull();
        expect(screen.getAllByText("Source link not established.").length).toBeGreaterThan(0);
    });

    it("never makes a provisional source clickable during paced content updates", () => {
        const link = { source_id: "TH-S09-SRC-0001", label: "Ninth Circuit recorded original", url: "https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/22/22-10312.pdf", basis: "capture_observation" };
        const { rerender } = render(<AssistantMessage isStreaming events={[mcp({ isStreaming: true })]} />);
        for (let index = 1; index <= 100; index++) {
            rerender(<AssistantMessage isStreaming events={[
                mcp({ isStreaming: true, source_links: [link] }),
                { type: "content", text: "Research. ".repeat(index) + "[Guessed source](/sources/TH-S01-SRC-0001)" },
            ]} />);
            expect(screen.queryByRole("link")).toBeNull();
        }
        rerender(<AssistantMessage events={[mcp({ source_links: [link] }), { type: "content", text: "Research complete." }]} />);
        expect(screen.getByRole("link", { name: link.label })).toHaveAttribute("href", link.url);
    });

    it("refuses witnesses attached to another tool or an unsafe persisted URL", () => {
        const value = { source_id: "TH-S01-SRC-0001", label: "SEC", url: "https://www.sec.gov/source", basis: "discovery" };
        render(<AssistantMessage events={[
            mcp({ tool_name: "source_list", source_links: [value] }),
            mcp({ source_links: [{ ...value, url: "javascript:alert(1)" }] }),
        ]} />);
        expect(screen.queryByRole("link")).toBeNull();
        expect(screen.getAllByText("Source link not established.").length).toBeGreaterThan(0);
    });

    it("ignores source links from failed or interrupted MCP calls", () => {
        render(
            <AssistantMessage
                events={[
                    mcp({
                        status: "error",
                        source_links: [{ source_id: "SEC-FAKE", label: "SEC", url: "https://www.sec.gov/litigation/complaints/2018/comp-pr2018-41-theranos-holmes.pdf", basis: "discovery" }],
                    }),
                    mcp({
                        isStreaming: false,
                        interrupted: true,
                        source_links: [{ source_id: "NINTH-FAKE", label: "Ninth Circuit", url: "https://cdn.ca9.uscourts.gov/datastore/opinions/2025/12/22/22-10312.pdf", basis: "discovery" }],
                    }),
                ]}
            />,
        );
        expect(screen.getAllByText("Source link not established.").length).toBeGreaterThan(0);
        expect(screen.queryByRole("link")).toBeNull();
    });
});
