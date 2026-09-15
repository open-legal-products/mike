import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { useState } from "react";
import { compile } from "@tailwindcss/node";
import postcss from "postcss";
import { fireEvent, render, screen } from "@testing-library/react";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { PdfView } from "@/app/components/shared/views/PdfView";
import { ProjectDocumentTabs } from "./ProjectDocumentTabs";

const fetchState = vi.hoisted(() => ({
    loading: true,
    error: null as string | null,
}));
vi.mock("@/app/hooks/useFetchDocxBytes", () => ({
    useFetchDocxBytes: () => ({ bytes: null, ...fetchState }),
}));
vi.mock("@/app/hooks/useFetchSingleDoc", () => ({
    useFetchSingleDoc: () => ({ result: null, ...fetchState }),
}));

let stylesheet: HTMLStyleElement;
beforeAll(async () => {
    const base = resolve(process.cwd(), "src/app");
    const compiler = await compile(
        readFileSync(join(base, "globals.css"), "utf8"),
        {
            base,
            onDependency: () => {},
        },
    );
    const css = postcss.parse(compiler.build(["bg-app-surface"]));
    // jsdom does not apply cascade layers. These backgrounds have no
    // competing declarations, so flatten layers for its computed styles.
    css.walkAtRules("layer", (rule) => {
        if (rule.nodes) rule.replaceWith(rule.nodes);
        else rule.remove();
    });
    stylesheet = document.createElement("style");
    stylesheet.textContent = css.toString();
    document.head.append(stylesheet);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
});
afterAll(() => {
    stylesheet?.remove();
    vi.unstubAllGlobals();
});
afterEach(() => document.documentElement.classList.remove("dark"));

// jsdom leaves var() colors unresolved and does not inherit custom properties.
// Follow those references through the rendered DOM instead of testing classes
// or copying palette values. All declarations come from the production CSS.
function backgroundColor(element: Element): string {
    let color = getComputedStyle(element).backgroundColor;
    const visited = new Set<string>();
    while (color.startsWith("var(")) {
        const property = color.slice(4, -1).split(",")[0].trim();
        if (visited.has(property))
            throw new Error(`Circular color token: ${property}`);
        visited.add(property);
        let value = "";
        for (
            let node: Element | null = element;
            node && !value;
            node = node.parentElement
        ) {
            value = getComputedStyle(node).getPropertyValue(property).trim();
        }
        if (!value) throw new Error(`Missing color token: ${property}`);
        color = value;
    }
    return color;
}

function Harness() {
    const [activeTabId, setActiveTabId] = useState("docx");
    return (
        <div className="bg-app-surface" data-testid="resting-surface">
            <ProjectDocumentTabs
                tabs={[
                    { documentId: "docx", filename: "Draft.docx" },
                    { documentId: "pdf", filename: "Exhibit.pdf" },
                ]}
                documents={[]}
                activeTabId={activeTabId}
                onActivate={setActiveTabId}
                onClose={vi.fn()}
                onReorder={vi.fn()}
            />
            <div data-testid="docx-view">
                <DocxView documentId="docx" rounded={false} />
            </div>
            <div data-testid="pdf-view">
                <PdfView doc={{ document_id: "pdf" }} rounded={false} />
            </div>
        </div>
    );
}

describe("project document tab colors", () => {
    it.each([
        ["light", "loading"],
        ["light", "error"],
        ["dark", "loading"],
        ["dark", "error"],
    ])(
        "matches the document canvas in %s mode during %s and after switching tabs",
        (theme, state) => {
            document.documentElement.classList.toggle("dark", theme === "dark");
            fetchState.loading = state === "loading";
            fetchState.error =
                state === "error" ? "Document could not be loaded." : null;
            render(<Harness />);
            const docxTab = screen.getByRole("tab", { name: "Draft.docx" });
            const pdfTab = screen.getByRole("tab", { name: "Exhibit.pdf" });
            const docxCanvas =
                screen.getByTestId("docx-view").firstElementChild!;
            const pdfCanvas = screen.getByTestId("pdf-view").firstElementChild!;
            const resting = backgroundColor(
                screen.getByTestId("resting-surface"),
            );
            const canvas = backgroundColor(docxCanvas);
            expect(canvas).not.toBe("rgba(0, 0, 0, 0)");
            expect(canvas).not.toBe(resting);
            expect(backgroundColor(pdfCanvas)).toBe(canvas);
            expect(backgroundColor(docxTab)).toBe(canvas);
            expect(backgroundColor(pdfTab)).toBe(resting);
            fireEvent.click(pdfTab);
            expect(pdfTab).toHaveAttribute("aria-selected", "true");
            expect(backgroundColor(pdfTab)).toBe(canvas);
            expect(backgroundColor(docxTab)).toBe(resting);
        },
    );
});
