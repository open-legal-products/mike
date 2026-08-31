import { useState } from "react";
import type { Story } from "@ladle/react";
import { ChevronDown } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuRadioGroup,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownButton,
    LiquidDropdownCheckboxItem,
    LiquidDropdownContent,
    LiquidDropdownItem,
    LiquidDropdownRadioItem,
    LiquidDropdownSurface,
} from "@/app/components/ui/liquid-dropdown";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";

export default { title: "UI / LiquidDropdown" };

/**
 * The glass skin over `dropdown-menu` — this is the one to use in app chrome.
 * `selected` marks the current choice; focus gets a ring as well as a tint,
 * because the tint alone is roughly a 1% luminance step.
 */
export const Menu: Story = () => {
    const [model, setModel] = useState("Claude");

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <TabPillButton>
                    {model}
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                </TabPillButton>
            </DropdownMenuTrigger>
            <LiquidDropdownContent align="start">
                {["Claude", "GPT", "Gemini"].map((option) => (
                    <LiquidDropdownItem
                        key={option}
                        selected={option === model}
                        onSelect={() => setModel(option)}
                    >
                        {option}
                    </LiquidDropdownItem>
                ))}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
};

export const RadioAndCheckboxItems: Story = () => {
    const [jurisdiction, setJurisdiction] = useState("ny");
    const [includeExhibits, setIncludeExhibits] = useState(true);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <TabPillButton>
                    Filters
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                </TabPillButton>
            </DropdownMenuTrigger>
            <LiquidDropdownContent align="start">
                <DropdownMenuRadioGroup
                    value={jurisdiction}
                    onValueChange={setJurisdiction}
                >
                    <LiquidDropdownRadioItem value="ny">
                        New York
                    </LiquidDropdownRadioItem>
                    <LiquidDropdownRadioItem value="de">
                        Delaware
                    </LiquidDropdownRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <LiquidDropdownCheckboxItem
                    checked={includeExhibits}
                    onCheckedChange={setIncludeExhibits}
                >
                    Include exhibits
                </LiquidDropdownCheckboxItem>
            </LiquidDropdownContent>
        </DropdownMenu>
    );
};

/**
 * `LiquidDropdownSurface` + `LiquidDropdownButton` are the escape hatch for
 * menu-shaped chrome that is not a Radix menu — a popover body, a custom
 * listbox. They give the same surface and item treatment without the menu
 * semantics, so the caller owns the roles.
 */
export const StandaloneSurface: Story = () => (
    <LiquidDropdownSurface className="w-56 p-1.5">
        <LiquidDropdownButton className="flex w-full items-center rounded-lg px-3 py-1.5 text-left">
            Insert citation
        </LiquidDropdownButton>
        <LiquidDropdownButton className="flex w-full items-center rounded-lg px-3 py-1.5 text-left">
            Insert cross-reference
        </LiquidDropdownButton>
    </LiquidDropdownSurface>
);
