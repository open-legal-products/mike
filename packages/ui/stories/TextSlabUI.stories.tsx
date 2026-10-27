import { TextSlabUI } from "../src/TextSlabUI";

const meta = { title: "Shared UI / TextSlab" };
export default meta;

function Frame({ children }: { children: React.ReactNode }) {
    return <div className="w-full max-w-[30rem] p-3">{children}</div>;
}

export const Quote = () => (
    <Frame>
        <TextSlabUI className="w-full text-left">
            <p className="font-serif text-sm leading-6 text-gray-700">
                “Either party may terminate this agreement on thirty days’
                written notice.”{" "}
                <span className="text-sm text-gray-500">(Page 8)</span>
            </p>
        </TextSlabUI>
    </Frame>
);

export const SelectedQuote = () => (
    <Frame>
        <TextSlabUI selected className="w-full text-left">
            <p className="citation-quote-selected-text font-serif text-sm leading-6">
                “Either party may terminate this agreement on thirty days’
                written notice.”{" "}
                <span className="citation-quote-selected-muted text-sm">
                    (Page 8)
                </span>
            </p>
        </TextSlabUI>
    </Frame>
);

export const TrackedChangeDiff = () => (
    <Frame>
        <TextSlabUI className="font-sans text-xs leading-relaxed">
            <span className="text-green-700">
                Either party may terminate on thirty days’ written notice.
            </span>{" "}
            <span className="text-red-600 line-through">
                Either party may terminate with notice.
            </span>
        </TextSlabUI>
    </Frame>
);

export const Loading = () => (
    <Frame>
        <TextSlabUI className="animate-pulse">
            <div className="h-3 w-28 rounded bg-gray-200" />
            <div className="mt-2.5 h-3 w-full rounded bg-gray-200" />
            <div className="mt-2 h-3 w-2/3 rounded bg-gray-200" />
        </TextSlabUI>
    </Frame>
);
