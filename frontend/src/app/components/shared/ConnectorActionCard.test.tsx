import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ConnectorActionCard } from "./ConnectorActionCard";

it("renders prototype-named MCP argument keys literally at every depth", () => {
    render(<ConnectorActionCard item={{
        id: "approval", kind: "approval", title: "Custom action", connector_name: "MCP",
        tool_name: "custom", binding: { type: "mcp", connector_id: "c", tool_id: "t" },
        arguments: JSON.parse('{"constructor":"outer","toString":"text","__proto__":{"constructor":"nested","toString":"inner","__proto__":"literal"}}'),
    }} />);
    expect(screen.getByText("constructor", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("toString", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("__proto__", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText(/constructor: nested/)).toHaveTextContent("toString: inner");
    expect(screen.getByText(/constructor: nested/)).toHaveTextContent("__proto__: literal");
});
