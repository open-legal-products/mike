import { useEffect, useState } from "react";
import { DocxView } from "./DocxView";
import { DocumentAnnotationLayer } from "../DocumentAnnotationLayer";
import { DocumentTitleRow } from "../DocumentTitleRow";
import { CitationQuotesSection } from "../../assistant/CitationQuotesSection";
import { EditCardUI } from "@/shared/ui/EditCardUI";
import { RESPONSE_GLASS_SURFACE } from "../../assistant/message/messageStyles";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const meta = { title: "Documents / DOCX editor" };
export default meta;

const tableCells = ["P1 — Critical", "Complete loss of service or critical function unavailable; major business impact", "15 minutes", "4 hours"];
const tableCitation = tableCells.join("\n");

/** Local-only DOCX editor: generated sample or a file selected on this machine. */
export function EditDocument() {
    const [url, setUrl] = useState<string | null>(null);
    const [narrow, setNarrow] = useState(false);
    const [toolbarVisible, setToolbarVisible] = useState(true);
    const [quote, setQuote] = useState(false);
    const [laterQuote, setLaterQuote] = useState(false);
    const [tableQuote, setTableQuote] = useState(false);
    const [edit, setEdit] = useState(false);
    const [laterEdit, setLaterEdit] = useState(false);
    const [name, setName] = useState("Synthetic agreement.docx");
    useEffect(() => {
        let cancelled = false;
        let objectUrl: string | undefined;
        void import("docx").then(async ({
            Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
            FootnoteReferenceRun, InsertedTextRun, DeletedTextRun, Header, Footer, WidthType, TableLayoutType,
        }) => {
            const doc = new Document({
                styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
                footnotes: { "1": { children: [new Paragraph("This is a synthetic footnote for editor testing.")] } },
                sections: [{
                    headers: { default: new Header({ children: [new Paragraph("MIKE — SYNTHETIC DOCUMENT")] }) },
                    footers: { default: new Footer({ children: [new Paragraph("Local editor sample")] }) },
                    children: [
                        new Paragraph({ text: "Sample services agreement", heading: HeadingLevel.TITLE }),
                        new Paragraph({ children: [new TextRun("Payment is due within thirty days."), new FootnoteReferenceRun(1)] }),
                        new Paragraph({ children: [new TextRun({ text: "Arial bold sample", font: "Arial", bold: true })] }),
                        new Paragraph({ children: [new TextRun({ text: "Courier New sample", font: "Courier New" })] }),
                        new Paragraph({ children: [
                            new TextRun("The notice period is "),
                            new DeletedTextRun({ text: "thirty", id: 7, author: "Reviewer", date: "2026-09-23T00:00:00Z" }),
                            new InsertedTextRun({ text: "sixty", id: 8, author: "Reviewer", date: "2026-09-23T00:00:00Z" }),
                            new TextRun(" days."),
                        ] }),
                        new Table({ width: { size: 9000, type: WidthType.DXA }, columnWidths: [4500, 4500], layout: TableLayoutType.FIXED, rows: [
                            new TableRow({ children: [new TableCell({ width: { size: 4500, type: WidthType.DXA }, children: [new Paragraph("Service")] }), new TableCell({ width: { size: 4500, type: WidthType.DXA }, children: [new Paragraph("Fee")] })] }),
                            new TableRow({ children: [new TableCell({ width: { size: 4500, type: WidthType.DXA }, children: [new Paragraph("Document review")] }), new TableCell({ width: { size: 4500, type: WidthType.DXA }, children: [new Paragraph("$100")] })] }),
                        ] }),
                        ...Array.from({ length: 70 }, (_, index) => new Paragraph({
                            spacing: { after: 180 },
                            children: [new TextRun({ text: `Clause ${index + 1}. Confidential information must be protected by each party. This sample contains no client data.`, font: index % 2 ? "Calibri" : "Times New Roman" })],
                        })),
                        // Same wording as the first-page edit, but different IDs:
                        // navigation must reveal this revision before its page is painted.
                        new Paragraph({ children: [
                            new TextRun("The later notice period is "),
                            new DeletedTextRun({ text: "thirty", id: 27, author: "Reviewer", date: "2026-09-23T00:00:00Z" }),
                            new InsertedTextRun({ text: "sixty", id: 28, author: "Reviewer", date: "2026-09-23T00:00:00Z" }),
                            new TextRun(" days."),
                        ] }),
                        new Table({ width: { size: 9000, type: WidthType.DXA }, columnWidths: [1800, 4500, 1350, 1350], layout: TableLayoutType.FIXED, rows: [
                            new TableRow({ children: tableCells.map((text) => new TableCell({ children: [new Paragraph(text)] })) }),
                        ] }),
                    ],
                }],
            });
            const blob = await Packer.toBlob(doc);
            if (cancelled) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
        });
        return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
    }, []);
    useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <TabPillButtonUI active={narrow} onClick={() => setNarrow(!narrow)}>Narrow panel</TabPillButtonUI>
                <TabPillButtonUI active={quote} onClick={() => setQuote(!quote)}>Highlight citation</TabPillButtonUI>
                <TabPillButtonUI active={laterQuote} onClick={() => setLaterQuote(!laterQuote)}>Highlight later citation</TabPillButtonUI>
                <TabPillButtonUI active={tableQuote} onClick={() => { setTableQuote(!tableQuote); setQuote(false); setLaterQuote(false); setEdit(false); setLaterEdit(false); }}>Highlight table citation</TabPillButtonUI>
                <TabPillButtonUI active={edit} onClick={() => { setEdit(!edit); setLaterEdit(false); }}>Highlight edit</TabPillButtonUI>
                <TabPillButtonUI active={laterEdit} onClick={() => { setLaterEdit(!laterEdit); setEdit(false); }}>Highlight later edit</TabPillButtonUI>
                <PillButtonUI tone="white" onClick={() => {
                    setName("Invalid document.docx");
                    setUrl(URL.createObjectURL(new Blob(["invalid docx"])));
                }}>Try invalid file</PillButtonUI>
                <label className="text-xs">
                    Open local DOCX
                    <input type="file" accept=".docx" className="ml-2 rounded focus-visible:outline-2 focus-visible:outline-ring"
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) { setName(file.name); setUrl(URL.createObjectURL(file)); }
                        }} />
                </label>
            </div>
            <p className="text-sm">{name}</p>
            <div style={{ width: narrow ? 400 : 950, maxWidth: "100%", height: 720 }} className="flex overflow-hidden rounded-lg bg-app-surface">
                <DocumentAnnotationLayer
                    title={<DocumentTitleRow document={{ document_id: url ?? "sample", title: name, type: "docx", metadata: [], quotes: [] }} isReloading={false} compactActions={narrow} toolbarVisible={toolbarVisible} onToggleToolbar={() => setToolbarVisible((visible) => !visible)} />}
                    annotation={(edit || laterEdit) ? <div className="px-2 pb-2"><EditCardUI originalText="thirty" replacementText="sixty" onClose={() => { setEdit(false); setLaterEdit(false); }} className={`${RESPONSE_GLASS_SURFACE} p-2`} /></div>
                        : (quote || laterQuote || tableQuote) ? <CitationQuotesSection citationRef={1}
                            quotes={[{ id: "sample", quote: tableQuote ? tableCitation : laterQuote ? "Clause 70. Confidential information must be protected by each party." : "Payment is due within thirty days." }]}
                            activeQuoteId="sample" onClose={() => { setQuote(false); setLaterQuote(false); setTableQuote(false); }} /> : undefined}>
                {url && <DocxView documentId={url} displayUrl={url} cacheBytes={false} filename={name} defaultMode="edit" author="Sample reviewer"
                    toolbarVisible={toolbarVisible}
                    quotes={tableQuote ? [{ quote: tableCitation }] : laterQuote ? [{ quote: "Clause 70. Confidential information must be protected by each party." }]
                        : quote ? [{ quote: "Payment is due within thirty days." }] : []}
                    highlightEdit={(edit || laterEdit) ? { key: laterEdit ? "later-notice" : "notice", ins_w_id: laterEdit ? "28" : "8", inserted_text: "sixty", del_w_id: laterEdit ? "27" : "7", deleted_text: "thirty" } : null} />}
                </DocumentAnnotationLayer>
            </div>
        </div>
    );
}
