import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfView } from "./PdfView";
const mocks = vi.hoisted(() => ({ render: vi.fn(), stream: vi.fn(), result: {type:"pdf",buffer:new ArrayBuffer(4)}, observe: vi.fn(), observer: null as IntersectionObserverCallback | null }));
vi.mock("@/app/hooks/useFetchSingleDoc", () => ({useFetchSingleDoc: () => ({result:mocks.result, loading:false, error:null})}));
vi.mock("./highlightQuote", async importOriginal => ({
    ...await importOriginal<typeof import("./highlightQuote")>(),
    getPdfJs: async () => ({
        getDocument: () => ({promise:Promise.resolve({numPages:100, getPage: async (number:number) => ({
            getViewport: () => ({width:100,height:100}),
            render: () => {mocks.render(number); return {promise:Promise.resolve(),cancel(){}};},
            streamTextContent: () => {mocks.stream(number); return new ReadableStream({start(controller){controller.enqueue({items:[{str:`Page ${number} content`, transform:[1,0,0,10,0,0],width:80,height:10}]});controller.close();}});},
        })}),destroy:async()=>{}}),
        TextLayer: class {
            static cleanup() {}
            textDivs: HTMLElement[] = [];
            constructor(private options: {textContentSource: ReadableStream<{items:{str:string}[]}>; container: HTMLElement}) {}
            async render() {const reader=this.options.textContentSource.getReader(); for (;;) {const {value,done}=await reader.read();if(done)break;for(const item of value.items){const span=document.createElement("span");span.textContent=item.str;this.textDivs.push(span);this.options.container.appendChild(span);}}}
        },
    }),
}));
beforeEach(() => {
    vi.clearAllMocks();
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
