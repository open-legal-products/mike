import { FileText } from "lucide-react";
import {
    DocEditBlockUI,
    DocFindBlockUI,
    DocReadBlockUI,
    DocSearchBlockUI,
} from "@/shared/ui/DocumentEventBlocksUI";

const meta = { title: "Shared UI / DocumentEventBlocks" };
export default meta;

const search = { type: "doc_search" as const, search_id: "example", scope: "project",
    query: "change of control", offset: 0 };

export const DocumentSearch = () => (
    <div className="flex max-w-xl flex-col gap-8 p-4">
        <section><h2 className="mb-3 text-sm text-foreground">Searching</h2>
            <DocSearchBlockUI event={search} isStreaming />
        </section>
        <section><h2 className="mb-3 text-sm text-foreground">Completed</h2>
            <DocSearchBlockUI event={{ ...search, match_count: 3, next_offset: null }} showConnector />
            <div className="mt-3"><DocReadBlockUI filename="Services Agreement.docx" /></div>
        </section>
        <section><h2 className="mb-3 text-sm text-foreground">Incomplete coverage</h2>
            <DocSearchBlockUI event={{ ...search, scope: "library", match_count: 0,
                coverage: { total_versions: 24, indexed_versions: 20, pending_versions: 3,
                    failed_versions: 1, versions_needing_ocr: 2 } }} />
        </section>
        <section><h2 className="mb-3 text-sm text-foreground">Search failed</h2>
            <DocSearchBlockUI event={{ ...search, scope: "templates",
                error: "Document search could not be completed. Try again." }} />
        </section>
    </div>
);

export const Timeline = () => (
    <div className="flex max-w-md flex-col gap-4">
        <DocReadBlockUI
            filename="Services Agreement.docx"
            fileIcon={<FileText aria-hidden="true" className="h-3.5 w-3.5" />}
            showConnector
            onClick={() => undefined}
        />
        <DocFindBlockUI
            filename="Services Agreement.docx"
            query="termination"
            totalMatches={3}
            showConnector
            onClick={() => undefined}
        />
        <DocEditBlockUI
            label="Edited"
            filename="Services Agreement.docx"
            fileIcon={<FileText aria-hidden="true" className="h-3.5 w-3.5" />}
            detail="Updated the notice period"
        />
    </div>
);

export const StreamingAndError = () => (
    <div className="flex max-w-md flex-col gap-4">
        <DocReadBlockUI filename="Disclosure Schedule.docx" isStreaming />
        <DocEditBlockUI
            label="Edit failed"
            filename="Disclosure Schedule.docx"
            fileIcon={<FileText aria-hidden="true" className="h-3.5 w-3.5" />}
            detail="The clause could not be located"
            dotColor="red"
            labelTone="error"
        />
    </div>
);
