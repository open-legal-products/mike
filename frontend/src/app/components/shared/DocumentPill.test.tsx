import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentPill } from "./DocumentPill";

describe("DocumentPill", () => {
    it("opens and removes the document from its own buttons", async () => {
        const onOpen = vi.fn();
        const onRemove = vi.fn();
        render(<DocumentPill filename="msa.docx" onOpen={onOpen} onRemove={onRemove} />);
        await userEvent.click(screen.getByRole("button", { name: "Open msa.docx" }));
        await userEvent.click(screen.getByRole("button", { name: "Remove msa.docx" }));
        expect(onOpen).toHaveBeenCalledOnce();
        expect(onRemove).toHaveBeenCalledOnce();
    });

    it("reads a status after the name and can hold removal", () => {
        render(
            <DocumentPill filename="nda.pdf" status="Starting…" onRemove={vi.fn()} removeDisabled />,
        );
        expect(screen.getByTitle("nda.pdf · Starting…")).toHaveTextContent("nda.pdf, Starting…");
        expect(screen.getByRole("button", { name: "Remove nda.pdf" })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Open nda.pdf" })).toBeNull();
    });
});
