import { FileText } from "lucide-react";
import {
    DocEditBlockUI,
    DocFindBlockUI,
    DocReadBlockUI,
} from "@/shared/ui/DocumentEventBlocksUI";

const meta = { title: "Shared UI / DocumentEventBlocks" };
export default meta;

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
