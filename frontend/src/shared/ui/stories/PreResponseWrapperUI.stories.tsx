import { FileText, Search } from "lucide-react";
import {
    DocFindBlockUI,
    DocReadBlockUI,
} from "@/shared/ui/DocumentEventBlocksUI";
import { PreResponseWrapperUI } from "@/shared/ui/PreResponseWrapperUI";

const meta = { title: "Shared UI / PreResponseWrapper" };
export default meta;

export const Completed = () => (
    <div className="w-full max-w-[30rem]">
        <PreResponseWrapperUI
            stepCount={2}
            shouldMinimize={false}
            isStreaming={false}
        >
            <DocReadBlockUI
                filename="Services Agreement.docx"
                fileIcon={<FileText aria-hidden="true" className="h-3.5 w-3.5" />}
            />
            <DocFindBlockUI
                filename="Services Agreement.docx"
                query="limitation of liability"
                totalMatches={2}
            />
        </PreResponseWrapperUI>
    </div>
);

export const Working = () => (
    <div className="w-full max-w-[30rem]">
        <PreResponseWrapperUI
            stepCount={1}
            shouldMinimize={false}
            isStreaming
        >
            <div className="flex items-center gap-2 font-serif text-sm text-gray-500">
                <Search aria-hidden="true" className="h-3.5 w-3.5" />
                Reviewing relevant clauses…
            </div>
        </PreResponseWrapperUI>
    </div>
);

export const Minimized = () => (
    <div className="w-full max-w-[30rem]">
        <PreResponseWrapperUI stepCount={4} shouldMinimize isStreaming={false}>
            <p className="text-sm text-gray-500">Hidden until expanded.</p>
        </PreResponseWrapperUI>
    </div>
);
