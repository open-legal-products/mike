import type { Story } from "@ladle/react";
import { Button } from "@/app/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/app/components/ui/popover";

const meta = { title: "UI / Popover" };
export default meta;

/** Radix popover on the float-tier glass surface. Content is portalled. */
export const Default: Story = () => (
    <Popover>
        <PopoverTrigger asChild>
            <Button type="button" variant="outline">
                Open popover
            </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64">
            <p className="text-sm font-medium text-gray-900">Share this matter</p>
            <p className="mt-1 text-xs text-gray-400">
                Everyone with access can view documents and citations.
            </p>
        </PopoverContent>
    </Popover>
);

export const Alignment: Story = () => (
    <div className="flex items-center gap-3">
        {(["start", "center", "end"] as const).map((align) => (
            <Popover key={align}>
                <PopoverTrigger asChild>
                    <Button type="button" variant="outline" size="sm">
                        {align}
                    </Button>
                </PopoverTrigger>
                <PopoverContent align={align} className="w-48">
                    <p className="text-xs">Aligned to {align}.</p>
                </PopoverContent>
            </Popover>
        ))}
    </div>
);
