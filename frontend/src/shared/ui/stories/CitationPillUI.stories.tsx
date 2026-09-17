import { CitationPillUI } from "@/shared/ui/CitationPillUI";

const meta = { title: "Shared UI / CitationPill" };
export default meta;

export const States = () => (
    <div className="flex items-center gap-3">
        <CitationPillUI title="Open citation 1">1</CitationPillUI>
        <CitationPillUI active title="Currently selected citation 2">
            2
        </CitationPillUI>
        <CitationPillUI
            className="bg-red-100 text-red-700 hover:bg-red-200"
            title="Citation 3 could not be verified"
        >
            3
        </CitationPillUI>
    </div>
);

export const InText = () => (
    <p className="max-w-lg font-serif text-base leading-7 text-gray-700">
        The agreement can be terminated with thirty days&apos; written notice{" "}
        <CitationPillUI title="Open supporting source">1</CitationPillUI> unless
        the parties agree otherwise.
    </p>
);
