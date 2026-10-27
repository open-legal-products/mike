import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PythonRunBlock } from "./PythonRunBlock";

const run = {
    type: "python_run" as const,
    run_id: "run-1",
    description: "Total the rent schedule",
    code: "import pandas as pd\nprint(df.sum())",
    status: "completed" as const,
    stdout: "x".repeat(400),
    documents: [{ document_id: "doc-1", filename: "rent.xlsx" }],
    files: [{ document_id: "doc-2", filename: "totals.csv" }],
    duration_ms: 420,
};

describe("PythonRunBlock", () => {
    it("expands to the code and a wrapping output line, then collapses", () => {
        render(<PythonRunBlock event={run} />);

        const disclosure = screen.getByRole("button", { name: /Ran code/ });
        expect(disclosure).toHaveAttribute("aria-expanded", "false");
        expect(screen.queryByText(/print\(df\.sum\(\)\)/)).toBeNull();

        fireEvent.click(disclosure);
        expect(disclosure).toHaveAttribute("aria-expanded", "true");
        expect(screen.getByText(/print\(df\.sum\(\)\)/)).toBeInTheDocument();
        expect(screen.getByText("x".repeat(400))).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Copy code" })).toHaveAttribute("type", "button");
        expect(screen.getByText("Read rent.xlsx")).toBeInTheDocument();
        expect(screen.getByText("Saved totals.csv")).toBeInTheDocument();

        fireEvent.click(disclosure);
        expect(disclosure).toHaveAttribute("aria-expanded", "false");
    });

    it("shows the error for a failed run", () => {
        render(
            <PythonRunBlock
                event={{
                    ...run,
                    status: "failed",
                    stdout: "",
                    error: "The code raised an error on line 2.",
                    error_code: "python_error",
                }}
            />,
        );

        fireEvent.click(screen.getByRole("button", { name: /Code failed/ }));
        expect(screen.getByText("The code raised an error on line 2.")).toBeInTheDocument();
    });
});
