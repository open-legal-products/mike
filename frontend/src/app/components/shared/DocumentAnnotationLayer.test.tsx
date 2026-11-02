import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DocumentAnnotationLayer } from "./DocumentAnnotationLayer";

it("places annotations with the title before the viewer toolbar and preserves the editor when dismissed", () => {
    const mount = vi.fn();
    function Viewer() {
        const [value, setValue] = useState("Draft");
        useEffect(() => {
            mount();
        }, []);
        return (
            <>
                <div role="toolbar">Editor toolbar</div>
                <div
                    data-document-scroll-viewport
                    style={{ paddingBottom: 12 }}
                >
                    <input
                        aria-label="Document text"
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                    />
                </div>
            </>
        );
    }
    const view = (annotation = true) => (
        <DocumentAnnotationLayer
            title={<h2>Agreement.docx</h2>}
            annotation={
                annotation ? <button>Close citation</button> : undefined
            }
        >
            <Viewer />
        </DocumentAnnotationLayer>
    );
    const { rerender } = render(view());
    const title = screen.getByRole("heading");
    const annotation = screen.getByRole("region", {
        name: "Document annotation",
    });
    const header = title.closest("[data-document-panel-header]");
    expect(header).toContainElement(annotation);
    expect(header).not.toContainElement(screen.getByRole("toolbar"));
    expect(
        annotation.compareDocumentPosition(screen.getByRole("toolbar")) &
            Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Unsaved edits" } });
    const viewport = input.parentElement!;
    viewport.scrollTop = 200;
    rerender(view(false));
    expect(screen.queryByRole("region")).toBeNull();
    expect(input).toHaveValue("Unsaved edits");
    expect(viewport.scrollTop).toBe(200);
    expect(viewport.style.paddingBottom).toBe("12px");
    expect(viewport.style.scrollPaddingBottom).toBe("");
    rerender(view());
    expect(screen.getByRole("region")).toBeVisible();
    expect(input).toHaveValue("Unsaved edits");
    expect(mount).toHaveBeenCalledOnce();
});
