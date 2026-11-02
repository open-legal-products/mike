import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { listDocumentVersions } from "@/app/lib/mikeApi";
import { DocumentVersionPicker } from "./DocumentVersionPicker";

vi.mock("@/app/lib/mikeApi", () => ({ listDocumentVersions: vi.fn() }));
const versions = [
    {
        id: "v1",
        version_number: 1,
        filename: "Draft.docx",
        source: "upload",
        created_at: "2026-09-26",
    },
    {
        id: "v2",
        version_number: 2,
        filename: "Draft.docx",
        source: "upload",
        created_at: "2026-09-26",
    },
];
beforeEach(() => {
    vi.mocked(listDocumentVersions).mockReset();
});
it("shows the picker for multiple versions and selects a preview without activating it", async () => {
    vi.mocked(listDocumentVersions).mockResolvedValue({
        current_version_id: "v2",
        versions,
    });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
        <DocumentVersionPicker
            documentId="doc"
            versionId="v2"
            versionNumber={2}
            onSelect={onSelect}
        />,
    );
    await user.click(
        await screen.findByRole("button", {
            name: "Choose document version, currently V2",
        }),
    );
    expect(
        await screen.findByRole("menuitemradio", { name: /V2/ }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: /V1/ }));
    expect(onSelect).toHaveBeenCalledWith(versions[0]);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(listDocumentVersions).toHaveBeenCalledWith("doc");
});
it("keeps version switching unavailable during pending autosave", async () => {
    vi.mocked(listDocumentVersions).mockResolvedValue({
        current_version_id: "v2",
        versions,
    });
    const onSelect = vi.fn();
    render(
        <DocumentVersionPicker
            documentId="doc"
            versionId="v1"
            versionNumber={1}
            disabled
            onSelect={onSelect}
        />,
    );
    const button = await screen.findByRole("button", {
        name: /Choose document version/,
    });
    expect(button).toBeDisabled();
    await userEvent.setup().click(button);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
});
it.each([false, true])(
    "shows a plain version label for a single available version (with deleted version: %s)",
    async (includeDeleted) => {
        vi.mocked(listDocumentVersions).mockResolvedValue({
            current_version_id: "v2",
            versions: [
                ...(includeDeleted
                    ? [{ ...versions[0], deleted_at: "2026-09-26" }]
                    : []),
                versions[1],
            ],
        });
        render(<DocumentVersionPicker documentId="doc" onSelect={vi.fn()} />);
        expect(await screen.findByText("V2")).toBeVisible();
        expect(screen.queryByRole("button")).toBeNull();
        expect(screen.queryByRole("menu")).toBeNull();
    },
);
it("allows retry without exposing backend errors", async () => {
    vi.mocked(listDocumentVersions)
        .mockRejectedValueOnce(new Error("private storage error"))
        .mockResolvedValueOnce({ current_version_id: "v2", versions });
    render(<DocumentVersionPicker documentId="doc" onSelect={vi.fn()} />);
    await userEvent
        .setup()
        .click(
            await screen.findByRole("button", {
                name: "Retry loading document versions",
            }),
        );
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: /Choose document version/ }),
        ).toBeVisible(),
    );
    expect(screen.queryByText(/private storage/)).toBeNull();
});
