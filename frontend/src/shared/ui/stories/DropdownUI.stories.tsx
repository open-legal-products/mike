import { ChevronDown } from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownLabel,
    DropdownSeparator,
    DropdownTrigger,
} from "@/shared/ui/DropdownUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const meta = { title: "Shared UI / Dropdown" };
export default meta;

export const Default = () => (
    <Dropdown>
        <DropdownTrigger asChild>
            <PillButtonUI tone="white">
                Actions <ChevronDown aria-hidden="true" className="h-3 w-3" />
            </PillButtonUI>
        </DropdownTrigger>
        <DropdownContent align="start" sideOffset={6} className="w-48">
            <DropdownLabel>Document</DropdownLabel>
            <DropdownItem>Rename</DropdownItem>
            <DropdownItem selected>Duplicate</DropdownItem>
            <DropdownSeparator />
            <DropdownItem className="text-red-600">Delete</DropdownItem>
        </DropdownContent>
    </Dropdown>
);
