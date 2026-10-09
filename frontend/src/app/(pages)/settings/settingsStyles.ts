import { cn } from "@/app/lib/utils";

export const settingsGlassIconButtonClassName =
    "justify-center rounded-lg bg-transparent px-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40";

export function settingsTabButtonClassName(active: boolean) {
    return cn(
        "flex h-9 w-full items-center rounded-lg px-3 text-left text-sm font-medium whitespace-nowrap transition-colors",
        active
            ? "bg-gray-100 text-gray-900"
            : "text-gray-500 hover:bg-gray-50 hover:text-gray-900",
    );
}
