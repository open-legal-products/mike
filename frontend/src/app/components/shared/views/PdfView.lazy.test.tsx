import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfView } from "./PdfView";
const mocks = vi.hoisted(() => ({ render: vi.fn(), stream: vi.fn(), result: {type:"pdf",buffer:new ArrayBuffer(4)}, waits: new Map<number, Promise<void>>(), docGate: null as Promise<void> | null, observe: vi.fn(), observer: null as IntersectionObserverCallback | null }));
vi.mock("@/app/hooks/useFetchSingleDoc", () => ({useFetchSingleDoc: () => ({result:mocks.result, loading:false, error:null})}));
vi.mock("./highlightQuote", async importOriginal => ({
    ...await importOriginal<typeof import("./highlightQuote")>(),
    getPdfJs: async () => ({
        getDocument: () => ({promise:(mocks.docGate ?? Promise.resolve()).then(() => ({numPages:100, getPage: async (number:number) => ({
            getViewport: () => ({width:100,height:100}),
            render: () => {mocks.render(number); return {promise:mocks.waits.get(number) ?? Promise.resolve(),cancel(){}};},
            streamTextContent: () => {mocks.stream(number); return new ReadableStream({start(controller){controller.enqueue({items:[{str:`Page ${number} content`, transform:[1,0,0,10,0,0],width:80,height:10}]});controller.close();}});},
        })})),destroy:async()=>{}}),
        TextLayer: class {
            static cleanup() {}
            textDivs: HTMLElement[] = [];
            constructor(private options: {textContentSource: ReadableStream<{items:{str:string}[]}>; container: HTMLElement}) {}
            async render() {const reader=this.options.textContentSource.getReader(); for (;;) {const {value,done}=await reader.read();if(done)break;for(const item of value.items){const span=document.createElement("span");span.textContent=item.str;this.textDivs.push(span);this.options.container.appendChild(span);}}}
        },
    }),
}));
beforeEach(() => {
    vi.clearAllMocks(); mocks.waits.clear(); mocks.docGate = null;
    mocks.result={type:"pdf",buffer:new ArrayBuffer(4)};
    vi.stubGlobal("ResizeObserver", class {observe(){} disconnect(){}});
    vi.stubGlobal("IntersectionObserver", class {constructor(callback:IntersectionObserverCallback){mocks.observer=callback;} observe=mocks.observe; disconnect(){} });
    vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({} as CanvasRenderingContext2D);
    HTMLElement.prototype.scrollTo=vi.fn();
});
afterEach(() => {vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("PDF page rendering", () => {
    it("paints one initial page of a 100-page document and renders another only when visible", async () => {
        const {container}=render(<PdfView doc={{document_id:"doc"}} />);
        await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
        expect(mocks.render).toHaveBeenCalledWith(1);
        expect(container.querySelectorAll("canvas[width='0']")).toHaveLength(99);
        const target=container.querySelector('[data-page="50"]')!;
        await act(async () => {mocks.observer!([{target,isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver);});
        expect(mocks.render).toHaveBeenCalledTimes(2);
        expect(mocks.render).toHaveBeenLastCalledWith(50);
    });
    it("renders a cited page directly without painting earlier pages", async () => {
        render(<PdfView doc={{document_id:"doc"}} quotes={[{page:50,quote:"Page 50 content"}]} />);
        await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
        expect(mocks.render).toHaveBeenCalledWith(50);
        expect(mocks.stream).toHaveBeenCalledTimes(1);
    });
    it("searches a batch of missing quotes through text without painting the document", async () => {
        render(<PdfView doc={{document_id:"doc"}} quotes={[{quote:"absent one"},{quote:"absent two"}]} />);
        await waitFor(() => expect(mocks.stream).toHaveBeenCalledTimes(100));
        await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
        expect(mocks.render).toHaveBeenCalledWith(1);
    });
});

describe("citation selection while a cited page renders", () => {
    const highlighted = (view: ReturnType<typeof render>, page: number) =>
        view.container.querySelectorAll(".shadow-md")[page - 1]?.querySelector(".pdf-text-highlight") ?? null;
    const scrollTo = () => HTMLElement.prototype.scrollTo as ReturnType<typeof vi.fn>;
    /** Render the viewer, wait until it is revealed, and lay pages out 100px apart. */
    async function readyViewer() {
        const view = render(<PdfView doc={{document_id:"doc"}} />);
        await waitFor(() => expect((view.container.querySelector("[data-document-scroll-viewport]") as HTMLElement).style.opacity).toBe("1"));
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
            const all = [...view.container.querySelectorAll(".shadow-md")];
            const wrapper = this.closest(".shadow-md");
            const top = wrapper ? (all.indexOf(wrapper) + 1) * 100 : 0;
            return {top,bottom:top+10,left:0,right:100,width:100,height:10,x:0,y:top,toJSON(){}};
        });
        return view;
    }
    /** Hold `page`'s first render until the returned function is called. */
    function delayPage(page: number) {
        let release!: () => void;
        mocks.waits.set(page, new Promise<void>(resolve => {release = resolve;}));
        return release;
    }
    const select = (view: ReturnType<typeof render>, quotes: {page:number; quote:string}[]) =>
        act(async () => {view.rerender(<PdfView doc={{document_id:"doc"}} quotes={quotes} />);});

    it("keeps the latest selection when an earlier citation's page finishes rendering later", async () => {
        const view = await readyViewer();
        const releaseA = delayPage(50);
        const releaseC = delayPage(60);
        await select(view, [{page:50, quote:"Page 50 content"}]);
        await select(view, [{page:60, quote:"Page 60 content"}]);
        await select(view, [{page:1, quote:"Page 1 content"}]);
        expect(highlighted(view, 1)).not.toBeNull();
        expect(scrollTo()).toHaveBeenLastCalledWith(expect.objectContaining({top:105}));
        await act(async () => {releaseC(); releaseA();});
        expect(scrollTo()).toHaveBeenLastCalledWith(expect.objectContaining({top:105}));
        expect(highlighted(view, 50)).toBeNull();
        expect(highlighted(view, 60)).toBeNull();
        expect(highlighted(view, 1)).not.toBeNull();
    });

    it("leaves nothing highlighted when the selection is cleared while its page renders", async () => {
        const view = await readyViewer();
        const release = delayPage(50);
        await select(view, [{page:50, quote:"Page 50 content"}]);
        await select(view, []);
        const scrolls = scrollTo().mock.calls.length;
        await act(async () => {release();});
        expect(highlighted(view, 50)).toBeNull();
        expect(scrollTo().mock.calls.length).toBe(scrolls);
    });

    it("drops a pending highlight when the document changes", async () => {
        const view = await readyViewer();
        const release = delayPage(50);
        await select(view, [{page:50, quote:"Page 50 content"}]);
        mocks.result = {type:"pdf", buffer:new ArrayBuffer(4)};
        await act(async () => {view.rerender(<PdfView doc={{document_id:"other"}} />);});
        await waitFor(() => expect(mocks.render).toHaveBeenLastCalledWith(1));
        const scrolls = scrollTo().mock.calls.length;
        await act(async () => {release();});
        expect(view.container.querySelector(".pdf-text-highlight")).toBeNull();
        expect(scrollTo().mock.calls.length).toBe(scrolls);
    });

    it("highlights a selection made while the document is still loading", async () => {
        let loaded!: () => void;
        mocks.docGate = new Promise<void>(resolve => {loaded = resolve;});
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
            const all = [...document.querySelectorAll(".shadow-md")];
            const wrapper = this.closest(".shadow-md");
            const top = wrapper ? (all.indexOf(wrapper) + 1) * 100 : 0;
            return {top,bottom:top+10,left:0,right:100,width:100,height:10,x:0,y:top,toJSON(){}};
        });
        const view = render(<PdfView doc={{document_id:"doc"}} quotes={[{page:50, quote:"Page 50 content"}]} />);
        await select(view, [{page:1, quote:"Page 1 content"}]);
        await act(async () => {loaded();});
        await waitFor(() => expect((view.container.querySelector("[data-document-scroll-viewport]") as HTMLElement).style.opacity).toBe("1"));
        expect(highlighted(view, 1)).not.toBeNull();
        expect(highlighted(view, 50)).toBeNull();
        expect(scrollTo()).toHaveBeenLastCalledWith(expect.objectContaining({top:105}));
    });

    it("re-renders a zoom with the latest selection and drops the older pending one", async () => {
        const view = await readyViewer();
        const release = delayPage(50);
        await select(view, [{page:50, quote:"Page 50 content"}]);
        await select(view, [{page:1, quote:"Page 1 content"}]);
        const zoomIn = view.container.querySelectorAll("button")[1] as HTMLButtonElement;
        await act(async () => {zoomIn.click();});
        await waitFor(() => expect(highlighted(view, 1)).not.toBeNull());
        await act(async () => {release();});
        expect(highlighted(view, 50)).toBeNull();
        expect(scrollTo()).toHaveBeenLastCalledWith(expect.objectContaining({top:105}));
    });
});
