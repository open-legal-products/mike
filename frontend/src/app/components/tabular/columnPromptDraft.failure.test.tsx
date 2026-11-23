import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnConfig } from "@/app/components/shared/types";

// Drafting a column prompt can be refused (no tabular model chosen for the
// workspace) or fail (the model's provider is down). Each dialog that drafts
// one says so, with a Retry that drafts again, instead of going quietly idle.

const mocks = vi.hoisted(() => ({
    generateTabularColumnPrompt: vi.fn(),
    notifyError: vi.fn(),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    generateTabularColumnPrompt: mocks.generateTabularColumnPrompt,
}));
vi.mock("@/app/lib/userFacingError", () => ({
    notifyError: mocks.notifyError,
}));

import { AddColumnModal } from "./AddColumnModal";
import { TREditColumnMenu } from "./TREditColumnMenu";
import { WFEditColumnModal } from "../workflows/WFEditColumnModal";

const COLUMN = {
    index: 0,
    name: "Governing law",
    prompt: "",
    format: "text",
} as ColumnConfig;

async function expectReportedWithRetry() {
    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledTimes(1));
    const [error, options] = mocks.notifyError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(options).toMatchObject({ action: "draft the column prompt" });
    mocks.generateTabularColumnPrompt.mockResolvedValueOnce({
        prompt: "Drafted",
        source: "llm",
    });
    options.onRetry();
    await waitFor(() =>
        expect(mocks.generateTabularColumnPrompt).toHaveBeenCalledTimes(2),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateTabularColumnPrompt.mockRejectedValueOnce(
        new Error("model required"),
    );
});

describe("a failed column prompt draft", () => {
    it("is reported by Add Columns", async () => {
        render(
            <AddColumnModal open existingCount={0} onClose={() => {}} onAdd={() => {}} />,
        );
        fireEvent.change(screen.getByPlaceholderText("Column name"), {
            target: { value: "Governing law" },
        });
        fireEvent.click(screen.getByText("Auto-Generate Prompt"));
        await expectReportedWithRetry();
    });

    it("is reported by a review's column menu", async () => {
        const { container } = render(
            <TREditColumnMenu column={COLUMN} onSave={() => {}} onDelete={() => {}} />,
        );
        fireEvent.click(container.querySelector("button")!);
        fireEvent.click(await screen.findByText("Auto-generate"));
        await expectReportedWithRetry();
    });

    it("is reported by a workflow's column editor", async () => {
        render(
            <WFEditColumnModal
                column={COLUMN}
                onClose={() => {}}
                onSave={() => {}}
                onDelete={() => {}}
            />,
        );
        fireEvent.click(screen.getByText("Auto-Generate Prompt"));
        await expectReportedWithRetry();
    });
});
