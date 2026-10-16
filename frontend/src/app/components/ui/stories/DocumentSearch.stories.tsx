import { DocSearchBlock } from "@/app/components/assistant/message/DocSearchBlock";
import { DocReadBlockUI } from "@/shared/ui/DocumentEventBlocksUI";

const meta = { title: "Assistant / Document Search" };
export default meta;

const search = { type: "doc_search" as const, search_id: "example", scope: "project",
    query: "change of control", offset: 0 };

export const DocumentSearch = () => (
    <div className="flex max-w-xl flex-col gap-8 p-4">
        <section><h2 className="mb-3 text-sm text-foreground">Searching</h2>
            <DocSearchBlock event={search} isStreaming />
        </section>
        <section><h2 className="mb-3 text-sm text-foreground">Completed</h2>
            <DocSearchBlock event={{ ...search, match_count: 3, next_offset: null }} showConnector />
            <div className="mt-3"><DocReadBlockUI filename="Services Agreement.docx" /></div>
        </section>
        <section><h2 className="mb-3 text-sm text-foreground">Zero matches</h2>
            <DocSearchBlock event={{ ...search, scope: "library", match_count: 0,
                coverage: { total_versions: 24, indexed_versions: 20, pending_versions: 3,
                    failed_versions: 1, versions_needing_ocr: 2 } }} />
        </section>
        <section><h2 className="mb-3 text-sm text-foreground">Search failed</h2>
            <DocSearchBlock event={{ ...search, scope: "templates",
                error: "Document search could not be completed. Try again." }} />
        </section>
    </div>
);
