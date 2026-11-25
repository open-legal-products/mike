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

it("offers a comparison with the previous version only when the host can show one", async () => {
    vi.mocked(listDocumentVersions).mockResolvedValue({
        current_version_id: "v2",
        versions: versions.map((version) => ({ ...version, file_type: "docx" })),
    });
    const onCompare = vi.fn();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    const view = render(<DocumentVersionPicker documentId="doc" versionId="v2" versionNumber={2} onSelect={onSelect} />);
    await user.click(await screen.findByRole("button", { name: "Choose document version, currently V2" }));
    expect(screen.queryByRole("menuitem", { name: "Compare with V1" })).toBeNull();
    await user.keyboard("{Escape}");
    view.unmount();

    render(<DocumentVersionPicker documentId="doc" versionId="v2" versionNumber={2} onSelect={onSelect} onCompare={onCompare} />);
    await user.click(await screen.findByRole("button", { name: "Choose document version, currently V2" }));
    await user.click(await screen.findByRole("menuitem", { name: "Compare with V1" }));
    expect(onCompare).toHaveBeenCalledTimes(1);
    expect(onCompare.mock.calls[0][0]).toMatchObject({ base: { id: "v1" }, target: { id: "v2" } });
    // Opening a comparison never changes which version is displayed.
    expect(onSelect).not.toHaveBeenCalled();
});

it("has no comparison to offer while the first version is displayed", async () => {
    vi.mocked(listDocumentVersions).mockResolvedValue({
        current_version_id: "v2",
        versions: versions.map((version) => ({ ...version, file_type: "docx" })),
    });
    const user = userEvent.setup();
    render(<DocumentVersionPicker documentId="doc" versionId="v1" versionNumber={1} onSelect={vi.fn()} onCompare={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Choose document version, currently V1" }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /V2/ })).toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: /Compare with/ })).toBeNull();
});

it.each([0, 1])("explains the file size limit when either version exceeds it", async index => {
    vi.mocked(listDocumentVersions).mockResolvedValue({
        current_version_id: "v2", versions: versions.map((version, i) =>
            ({ ...version, size_bytes: i === index ? 20 * 1024 * 1024 + 1 : null })),
    });
    const user = userEvent.setup();
    render(<DocumentVersionPicker documentId="doc" onSelect={vi.fn()} onCompare={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /Choose document version/ }));
    expect(screen.getByRole("menuitem", { name: /Compare with V1.*20 MiB/ })).toHaveAttribute("aria-disabled", "true");
});
