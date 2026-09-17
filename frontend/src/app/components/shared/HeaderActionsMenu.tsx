"use client";

import { MoreHorizontal, type LucideIcon } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_HOVER_CLASS } from "@/app/components/ui/liquid-surface";

export type HeaderActionsMenuItem = {
    label: string;
    icon?: LucideIcon;
    onSelect: () => void;
    disabled?: boolean;
    variant?: "default" | "danger";
};

export function HeaderActionsMenu({
    items,
    title = "Actions",
    triggerClassName,
    onCloseAutoFocus,
}: {
    items: HeaderActionsMenuItem[];
    title?: string;
    triggerClassName?: string;
    onCloseAutoFocus?: (event: Event) => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-600 transition-all",
                        LIQUID_GLASS_HOVER_CLASS,
                        "hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-300",
                        triggerClassName,
                    )}
                    aria-label={title}
                    title={title}
                >
                    <MoreHorizontal className="h-4 w-4" />
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                align="end"
                className="z-[160] w-48"
                onCloseAutoFocus={onCloseAutoFocus}
            >
                {items.map((item) => {
                    const Icon = item.icon;
                    return (
                        <LiquidDropdownItem
                            key={item.label}
                            disabled={item.disabled}
                            variant={
                                item.variant === "danger"
                                    ? "destructive"
                                    : "default"
                            }
                            onSelect={item.onSelect}
                            className={cn(
                                "cursor-pointer text-xs",
                                item.variant === "danger" &&
                                    "text-red-600 focus:bg-red-50 focus:text-red-700",
                            )}
                        >
                            {Icon && <Icon className="h-3.5 w-3.5" />}
                            {item.label}
                        </LiquidDropdownItem>
                    );
                })}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}
