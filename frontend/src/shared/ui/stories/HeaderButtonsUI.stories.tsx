import { Plus, Search, Settings } from "lucide-react";
import {
    HeaderButtonUI,
    HeaderButtonsUI,
} from "@/shared/ui/HeaderButtonsUI";

const meta = { title: "Shared UI / HeaderButtons" };
export default meta;

export const Actions = () => (
    <HeaderButtonsUI>
        <HeaderButtonUI aria-label="New">
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New</span>
        </HeaderButtonUI>
        <HeaderButtonUI aria-label="Search">
            <Search aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Search</span>
        </HeaderButtonUI>
        <HeaderButtonUI iconOnly aria-label="Settings">
            <Settings aria-hidden="true" className="h-3.5 w-3.5" />
        </HeaderButtonUI>
    </HeaderButtonsUI>
);

export const Disabled = () => (
    <HeaderButtonsUI>
        <HeaderButtonUI aria-label="New" disabled>
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">New</span>
        </HeaderButtonUI>
    </HeaderButtonsUI>
);
