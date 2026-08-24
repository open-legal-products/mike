import { describe, expect, it } from "vitest";

import {
    collapseTrademarkOwnerCalls,
    parseTextToolCalls,
    TextToolMarkupFilter,
    ThinkTagFilter,
} from "../llm/toolCallParsing";

const TOOL = "mcp_search_trademarks";

describe("parseTextToolCalls", () => {
    it("returns nothing when the model simply answered", () => {
        expect(parseTextToolCalls("Here is the answer.", 0)).toEqual([]);
    });

    it("reads a well-formed JSON tool_call block", () => {
        const text = `Calling tool.\n<tool_call>{"name":"${TOOL}","arguments":{"query":"MIKE"}}</tool_call>`;
        expect(parseTextToolCalls(text, 0)).toEqual([
            { id: "call_text_0_0_0", name: TOOL, input: { query: "MIKE" } },
        ]);
    });

    it("repairs Python-style quoting, trailing commas and a missing close tag", () => {
        const text = `Calling tool.\n<tool_call>{'name':'${TOOL}','arguments':{'query':'JACK HENRY',},`;
        expect(parseTextToolCalls(text, 0)).toEqual([
            {
                id: "call_text_0_0_0",
                name: TOOL,
                input: { query: "JACK HENRY" },
            },
        ]);
    });

    it("normalizes OpenArc's doubled-delimiter map-style call", () => {
        const text = `Calling tool.\n<tool_call>{""${TOOL}"::{"owner_name":"Jack Henry","limit":100}}</tool_call>`;
        expect(parseTextToolCalls(text, 0)).toEqual([
            {
                id: "call_text_0_0_0",
                name: TOOL,
                input: { owner_name: "Jack Henry", limit: 100 },
            },
        ]);
    });

    it("reads an XML-style function block and types its scalars", () => {
        const text = [
            "Calling tool.",
            "<tool_call>",
            `<function=${TOOL}>`,
            "<limit>100</limit>",
            "<owner_name>Jack Henry & Associates</owner_name>",
            "<status_filter>live</status_filter>",
            "</function>",
            "</tool_call>",
        ].join("\n");
        expect(parseTextToolCalls(text, 0)).toEqual([
            {
                id: "call_text_0_0_xml",
                name: TOOL,
                input: {
                    limit: 100,
                    owner_name: "Jack Henry & Associates",
                    status_filter: "live",
                },
            },
        ]);
    });

    it("reads DeepSeek DSML invocations", () => {
        const text = [
            "<｜DSML｜tool_calls>",
            `<｜DSML｜invoke name="${TOOL}">`,
            '<｜DSML｜parameter name="owner_name" string="true">GARITY ASSOCIATES BROKERAGE INSURANCE AGENCY, LLC</｜DSML｜parameter>',
            "</｜DSML｜invoke>",
            `<｜DSML｜invoke name="${TOOL}">`,
            '<｜DSML｜parameter name="owner_name" string="true">GENERAL AGENT INSURANCE NETWORK, LLC</｜DSML｜parameter>',
            "</｜DSML｜invoke>",
            "</｜DSML｜tool_calls>",
        ].join("\n");
        expect(parseTextToolCalls(text, 0)).toEqual([
            {
                id: "call_text_0_dsml_0",
                name: TOOL,
                input: {
                    owner_name:
                        "GARITY ASSOCIATES BROKERAGE INSURANCE AGENCY, LLC",
                },
            },
            {
                id: "call_text_0_dsml_1",
                name: TOOL,
                input: { owner_name: "GENERAL AGENT INSURANCE NETWORK, LLC" },
            },
        ]);
    });

    it("deduplicates identical repeated calls", () => {
        const call = `<tool_call>{"name":"${TOOL}","arguments":{"query":"MIKE"}}</tool_call>`;
        expect(parseTextToolCalls(`${call}\n${call}`, 0)).toHaveLength(1);
    });

    it("raises a recoverable-failure message when the markup names no tool", () => {
        expect(() =>
            parseTextToolCalls("<tool_call>{not a tool at all}</tool_call>", 0),
        ).toThrow(/did not identify an executable tool|could not recover/);
    });
});

// Only the MCP trademark search batches; the collapse keys off that name.
const TM_TOOL = "mcp_uspto_patent_trade_tm_search_trademarks_f77b105c";

describe("collapseTrademarkOwnerCalls", () => {
    it("batches repeated owner searches into a single owner_names call", () => {
        const calls = [
            {
                id: "call_text_0_dsml_0",
                name: TM_TOOL,
                input: { owner_name: "GARITY ASSOCIATES" },
            },
            {
                id: "call_text_0_dsml_1",
                name: TM_TOOL,
                input: { owner_name: "GENERAL AGENT INSURANCE NETWORK, LLC" },
            },
        ];
        expect(collapseTrademarkOwnerCalls(calls)).toEqual([
            {
                id: "call_text_0_dsml_0",
                name: TM_TOOL,
                input: {
                    owner_names: [
                        "GARITY ASSOCIATES",
                        "GENERAL AGENT INSURANCE NETWORK, LLC",
                    ],
                },
            },
        ]);
    });

    it("leaves a lone owner search alone", () => {
        const calls = [
            { id: "a", name: TM_TOOL, input: { owner_name: "ONLY ONE" } },
        ];
        expect(collapseTrademarkOwnerCalls(calls)).toEqual(calls);
    });
});

describe("ThinkTagFilter", () => {
    it("routes think blocks to reasoning and keeps the rest visible", () => {
        const filter = new ThinkTagFilter();
        const fed = filter.feed("<think>weighing it</think>The answer.");
        expect(fed.reasoning.join("")).toBe("weighing it");
        expect(fed.content.join("")).toBe("The answer.");
        expect(filter.sawReasoning).toBe(true);
    });

    it("holds a tag split across chunks instead of leaking it", () => {
        const filter = new ThinkTagFilter();
        const first = filter.feed("visible <thi");
        expect(first.content.join("")).toBe("visible ");
        const second = filter.feed("nk>hidden</think> tail");
        expect(second.reasoning.join("")).toBe("hidden");
        expect(second.content.join("")).toBe(" tail");
    });
});

describe("TextToolMarkupFilter", () => {
    it("suppresses everything from the tool marker onward", () => {
        const filter = new TextToolMarkupFilter();
        expect(filter.feed(`Calling tool.\n<tool_call>{"name":"x"}`)).toBe(
            "Calling tool.\n",
        );
        expect(filter.feed("more markup")).toBe("");
        expect(filter.flush()).toBe("");
    });

    it("suppresses a marker that arrives split across chunks", () => {
        const filter = new TextToolMarkupFilter();
        expect(filter.feed("Calling tool. <｜DSM")).toBe("Calling tool. ");
        expect(filter.feed("L｜tool_calls> ...")).toBe("");
        expect(filter.flush()).toBe("");
    });

    it("passes ordinary prose straight through", () => {
        const filter = new TextToolMarkupFilter();
        expect(filter.feed("A normal answer.")).toBe("A normal answer.");
        expect(filter.flush()).toBe("");
    });
});
