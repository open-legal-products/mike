"use client";

import { MoreHorizontal, type LucideIcon } from "lucide-react";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
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
    modal = true,
}: {
    items: HeaderActionsMenuItem[];
    title?: string;
    triggerClassName?: string;
    onCloseAutoFocus?: (event: Event) => void;
    /**
     * False lets a press outside reach what is pressed, closing this menu on
     * the way. Use it for a menu that sits beside other menus' buttons which
     * stay clickable while it is open (a floating header's `pointer-events`
     * do that): a modal menu ignores a press that opens a newer menu, so
     * both would stay open.
     */
    modal?: boolean;
}) {
    return (
        <Dropdown modal={modal}>
            <DropdownTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "inline-flex h-7 w-7 items-center justify-center rounded-full text-gray-600 transition-all",
                        LIQUID_GLASS_HOVER_CLASS,
                        "hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40",
                        triggerClassName,
                    )}
                    aria-label={title}
                    title={title}
                >
                    <MoreHorizontal className="h-4 w-4" />
                </button>
            </DropdownTrigger>
            <DropdownContent
                align="end"
                className="w-48"
                onCloseAutoFocus={onCloseAutoFocus}
            >
                {items.map((item) => {
                    const Icon = item.icon;
                    return (
                        <DropdownItem
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
                        </DropdownItem>
                    );
                })}
            </DropdownContent>
        </Dropdown>
    );
}
