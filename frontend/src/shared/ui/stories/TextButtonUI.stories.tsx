import { Download, ExternalLink } from "lucide-react";
import { TextButtonUI } from "../TextButtonUI";
import { textButtonUIClassName } from "../TextButtonUI.styles";

const meta = { title: "Shared UI / TextButton" };
export default meta;

export const TextAndIcons = () => (
    <div className="flex flex-wrap items-center gap-4">
        <TextButtonUI>Cancel</TextButtonUI>
        <TextButtonUI>
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
            Download
        </TextButtonUI>
        <TextButtonUI size="icon-xs" aria-label="Download">
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
        </TextButtonUI>
        <a href="#text-button-example" className={textButtonUIClassName()}>
            <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
            Source link
        </a>
    </div>
);

export const Sizes = () => (
    <div className="flex items-center gap-4">
        <TextButtonUI size="xs">Extra small</TextButtonUI>
        <TextButtonUI size="sm">Small</TextButtonUI>
        <TextButtonUI size="normal">Normal</TextButtonUI>
    </div>
);

export const States = () => (
    <div className="flex items-center gap-4">
        <TextButtonUI disabled>Disabled</TextButtonUI>
        <TextButtonUI loading>
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
            Download
        </TextButtonUI>
        <TextButtonUI size="icon-xs" loading aria-label="Download">
            <Download aria-hidden="true" className="h-3.5 w-3.5" />
        </TextButtonUI>
    </div>
);
