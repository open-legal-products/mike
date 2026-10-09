import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
    Editor,
    ReviewItemPlacement,
} from "@docx-editor.dev/core/contracts/editor";
import { DocxReviewActions } from "./DocxReviewActions";
import { docxReviewTarget } from "./docxReviewTarget";

vi.mock("@docx-editor.dev/react", () => ({ useEditorSnapshot: vi.fn() }));
let surface: HTMLDivElement;
beforeEach(() => {
    surface = document.createElement("div");
    document.body.append(surface);
});
afterEach(() => surface.remove());
function fixture(kind = "comment", readOnly = false) {
    surface.innerHTML =
        kind === "comment"
            ? '<section tabindex="0" data-comment-key="comment-1">Comment</section>'
            : '<span data-paragraph-id="/word/document.xml#p2" data-revision-id="8" data-review-author="Author" data-revision-date="date">Inserted text</span>';
    const item = {
        kind,
        key: kind === "comment" ? "comment-1" : "change-2",
        readOnly,
        item: {
            addresses: [{ id: "8", author: "Author", date: "date" }],
            ranges: [{ partName: "/word/document.xml" }],
        },
    };
    const editor = {
        snapshot: () => ({ editable: true, editingMode: "editing" }),
        getReviewItems: () => [item] as unknown as ReviewItemPlacement[],
        deleteReviewItem: vi.fn().mockReturnValue({ ok: true }),
        acceptReviewItem: vi.fn().mockReturnValue({ ok: true }),
        rejectReviewItem: vi.fn().mockReturnValue({ ok: true }),
    };
    return editor;
}
it("offers reply and delete for the clicked comment, and passes its identity to reply", async () => {
    const editor = fixture();
    const onReply = vi.fn();
    render(
        <DocxReviewActions
            editor={editor as unknown as Editor}
            surface={surface}
            author="Reviewer"
            onReply={onReply}
        />,
    );
    fireEvent.contextMenu(surface.firstElementChild!, {
        clientX: 30,
        clientY: 50,
    });
    expect(
        screen.getByRole("menuitem", { name: "Delete comment" }),
    ).toBeVisible();
    expect(screen.queryByText("Accept tracked change")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply to comment" }));
    await waitFor(() => expect(onReply).toHaveBeenCalledWith("comment-1"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});
it.each(["delete", "accept", "reject"] as const)(
    "runs %s on the clicked item without moving the caret",
    (action) => {
        const editor = fixture(action === "delete" ? "comment" : "revision");
        const normalMenu = vi.fn();
        surface.addEventListener("contextmenu", normalMenu);
        render(
            <DocxReviewActions
                editor={editor as unknown as Editor}
                surface={surface}
                author="Reviewer"
                onReply={vi.fn()}
            />,
        );
        fireEvent.contextMenu(surface.firstElementChild!);
        const label =
            action === "delete"
                ? "Delete comment"
                : action === "accept"
                  ? "Accept tracked change"
                  : "Reject tracked change";
        fireEvent.click(screen.getByRole("menuitem", { name: label }));
        expect(editor[`${action}ReviewItem`]).toHaveBeenCalledWith(
            action === "delete" ? "comment-1" : "change-2",
        );
        expect(normalMenu).not.toHaveBeenCalled();
    },
);
it("leaves the normal menu alone for plain document text and refuses ambiguous revision identities", () => {
    const editor = fixture("revision");
    expect(
        docxReviewTarget(surface.firstElementChild!, [
            ...editor.getReviewItems(),
            ...editor.getReviewItems(),
        ]),
    ).toBeUndefined();
    const normalMenu = vi.fn();
    surface.addEventListener("contextmenu", normalMenu);
    render(
        <DocxReviewActions
            editor={editor as unknown as Editor}
            surface={surface}
            author="Reviewer"
            onReply={vi.fn()}
        />,
    );
    fireEvent.contextMenu(surface);
    expect(normalMenu).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
});
it("disables unsupported changes and supports keyboard context menus", () => {
    const editor = fixture("revision", true);
    render(
        <DocxReviewActions
            editor={editor as unknown as Editor}
            surface={surface}
            onReply={vi.fn()}
        />,
    );
    fireEvent.keyDown(surface.firstElementChild!, {
        key: "F10",
        shiftKey: true,
    });
    expect(
        screen.getByRole("menuitem", { name: "Accept tracked change" }),
    ).toHaveAttribute("aria-disabled", "true");
});
it("reports a refused delete without exposing internal errors", () => {
    const editor = fixture();
    editor.deleteReviewItem.mockReturnValue({
        ok: false,
        reason: "private engine failure",
    });
    render(
        <DocxReviewActions
            editor={editor as unknown as Editor}
            surface={surface}
            onReply={vi.fn()}
        />,
    );
    fireEvent.contextMenu(surface.firstElementChild!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete comment" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
        "This action could not be applied.",
    );
    expect(screen.queryByText("private engine failure")).toBeNull();
});
it("matches the clicked author's change rather than another revision with the same ID", () => {
    const editor = fixture("revision");
    const other = {
        ...editor.getReviewItems()[0],
        key: "unrelated",
        item: {
            addresses: [{ id: "8", author: "Other author", date: "date" }],
            ranges: [{ partName: "/word/document.xml" }],
        },
    } as unknown as ReviewItemPlacement;
    expect(
        docxReviewTarget(surface.firstElementChild!, [
            other,
            ...editor.getReviewItems(),
        ])?.key,
    ).toBe("change-2");
});

it("offers View and Delete when a comment highlight is right-clicked, once the engine activates it", async () => {
    surface.innerHTML =
        '<span>Commented text</span><div class="docx-comment-overlay"><div class="docx-comment-band"></div></div>';
    const band = surface.querySelector<HTMLElement>(".docx-comment-band")!;
    band.getBoundingClientRect = () => new DOMRect(10, 20, 200, 12);
    let active = false;
    const comment = () => ({
        kind: "comment",
        key: "comment-7",
        id: "7",
        author: "Reviewer",
        isActive: active,
        readOnly: false,
        replyIds: [],
        item: {
            range: {
                partName: "/word/document.xml",
                start: { paragraphId: "p1", offset: 0 },
                end: { paragraphId: "p1", offset: 9 },
            },
            orphaned: false,
        },
    });
    const editor = {
        ...fixture(),
        getReviewItems: () => [comment()] as unknown as ReviewItemPlacement[],
    };
    surface.innerHTML =
        '<span>Commented text</span><div class="docx-comment-overlay"></div>';
    surface.querySelector(".docx-comment-overlay")!.append(band);
    const onView = vi.fn();
    const normalMenu = vi.fn();
    surface.addEventListener("contextmenu", normalMenu);
    render(
        <DocxReviewActions
            editor={editor as unknown as Editor}
            surface={surface}
            author="Reviewer"
            onReply={vi.fn()}
            onEdit={vi.fn()}
            onView={onView}
        />,
    );
    fireEvent.contextMenu(surface.firstElementChild!, {
        clientX: 50,
        clientY: 25,
    });
    // The native menu is suppressed immediately on a highlight.
    expect(normalMenu).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    // The engine paints the pressed comment as active on a later frame.
    active = true;
    band.className = "docx-comment-band docx-comment-band--active";
    expect(
        await screen.findByRole("menuitem", { name: "Delete comment" }),
    ).toBeVisible();
    // Highlights offer View and Delete; Reply and Edit live on the bubble.
    expect(
        screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["View comment", "Delete comment"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "View comment" }));
    await waitFor(() => expect(onView).toHaveBeenCalledWith("comment-7"));
});

it("does not resolve a comment left active elsewhere when the click misses its band", async () => {
    surface.innerHTML =
        '<span>Other text</span><div class="docx-comment-overlay"><div class="docx-comment-band docx-comment-band--active"></div><div class="docx-comment-band"></div></div>';
    const [activeBand, clickedBand] = surface.querySelectorAll<HTMLElement>(
        ".docx-comment-band",
    );
    activeBand.getBoundingClientRect = () => new DOMRect(10, 300, 200, 12);
    clickedBand.getBoundingClientRect = () => new DOMRect(10, 20, 200, 12);
    const editor = {
        ...fixture(),
        getReviewItems: () =>
            [
                { kind: "comment", key: "comment-far", isActive: true },
            ] as unknown as ReviewItemPlacement[],
    };
    const frames = vi
        .spyOn(window, "requestAnimationFrame")
        .mockImplementation((callback) => {
            callback(0);
            return 0;
        });
    render(
        <DocxReviewActions
            editor={editor as unknown as Editor}
            surface={surface}
            author="Reviewer"
            onReply={vi.fn()}
        />,
    );
    fireEvent.contextMenu(surface.firstElementChild!, {
        clientX: 50,
        clientY: 25,
    });
    expect(screen.queryByRole("menu")).toBeNull();
    frames.mockRestore();
});
