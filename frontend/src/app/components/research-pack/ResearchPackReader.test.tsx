import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { verifyResearchPackFile } from "@/app/lib/researchPackClient";
import { ResearchPackReader } from "./ResearchPackReader";

vi.mock("@/app/lib/researchPackClient", () => ({ verifyResearchPackFile: vi.fn() }));

const filename = "assessment-context-r2.research-pack.json";
const source = readFileSync(
    resolve("../tests/fixtures/research-workspace-portable-v02", filename),
    "utf8",
);
const fixture = JSON.parse(source);

describe("Research Pack reader", () => {
    it("keeps each assessment, saved review and export-time observation with its referent", async () => {
        const file = new File([source], filename, { type: "application/json" });
        vi.mocked(verifyResearchPackFile).mockResolvedValue({
            file,
            pack: fixture,
            report: { integrity: "pass", input_sha256: null, authenticity: "not_established" },
        });
        const { container } = render(<ResearchPackReader />);
        const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
        fireEvent.change(input, { target: { files: [file] } });
        await screen.findByRole("heading", { name: filename });
        const article = within(screen.getByRole("article"));
        const observationId = fixture.revisions[1].observations[0].observation_id;
        for (
            const [claim, stance] of [
                ["The committee met on Monday.", "supports"],
                ["The committee approved the motion unanimously.", "conflicts"],
            ]
        ) {
            const group = article.getByText(claim).closest("dl")!.parentElement!;
            const row = within(group).getByText(observationId).closest("dl")!;
            expect(within(row).getByText(stance)).toBeVisible();
        }
        const r1Note = "The memorandum records the meeting date.";
        const r2Note = "Compare the meeting date against the amended minutes.";
        const picker = screen.getByRole("combobox", { name: "Revision" });
        for (
            const [revision, decision, note, otherNote] of [
                ["2", "hold", r2Note, r1Note],
                ["1", "keep", r1Note, r2Note],
                ["2", "hold", r2Note, r1Note],
            ]
        ) {
            fireEvent.change(picker, { target: { value: revision } });
            const row = article.getByText("r01", { exact: true }).closest("dl")!;
            expect(within(row).getByText(decision)).toBeVisible();
            expect(within(row).getByText(note)).toBeVisible();
            expect(article.queryByText(otherNote)).toBeNull();
        }
        const availability = screen.getByRole("heading", {
            name: "Export-time readback availability",
        }).closest("section")!;
        const stale = within(availability).getByText("stale").closest("dl")!;
        expect(within(stale).getByText(observationId)).toBeVisible();
        expect(within(stale).getByText("Amended archive memorandum A")).toBeVisible();
        const first = within(availability).getByText("Synthetic archive memorandum A").closest(
            "dl",
        )!;
        expect(within(first).getByText(observationId)).toBeVisible();
        expect(within(first).getByText("current")).toBeVisible();
    });
});
