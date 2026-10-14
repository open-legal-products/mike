"use client";

import { useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { FORM_CONTROL_GLASS_CLASS } from "../ui/form-field";
import { textButtonUIClassName } from "@/shared/ui/TextButtonUI.styles";
import {
    Dropdown,
    DropdownContent,
    DropdownItem,
    DropdownTrigger,
} from "@/shared/ui/dropdown";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
} from "@/shared/ui/LiquidGlassUI";

export type ModalSelectOption =
    | string
    | {
          value: string;
          label: string;
          /** Muted text displayed inline after the label. */
          suffix?: string;
          icon?: LucideIcon;
          iconClassName?: string;
      };

interface ModalSelectProps {
    id: string;
    "aria-label"?: string;
    value: string;
    options: readonly ModalSelectOption[];
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    className?: string;
    menuClassName?: string;
    wrapLabels?: boolean;
    variant?: "glass" | "flat";
}

function normalizeOption(option: ModalSelectOption) {
    return typeof option === "string"
        ? { value: option, label: option }
        : option;
}

export function ModalSelect({
    id,
    "aria-label": ariaLabel,
    value,
    options,
    onChange,
    placeholder = "Select...",
    disabled = false,
    open,
    onOpenChange,
    className,
    menuClassName,
    wrapLabels = false,
    variant = "glass",
}: ModalSelectProps) {
    const [internalOpen, setInternalOpen] = useState(false);
    const isOpen = open ?? internalOpen;
    const normalizedOptions = options.map(normalizeOption);
    const selected = normalizedOptions.find((option) => option.value === value);
    const hasValue = value.trim().length > 0;

    function setOpen(next: boolean) {
        onOpenChange?.(next);
        if (open === undefined) {
            setInternalOpen(next);
        }
    }

    function handleSelect(nextValue: string) {
        setOpen(false);
        onChange(nextValue);
    }

    return (
        <Dropdown open={isOpen} onOpenChange={setOpen}>
            <DropdownTrigger asChild>
                <button
                    id={id}
                    aria-label={ariaLabel}
                    type="button"
                    disabled={disabled}
                    className={cn(
                        variant === "glass"
                            ? FORM_CONTROL_GLASS_CLASS
                            : textButtonUIClassName({
                                  className: "w-full rounded-xl bg-app-surface-active px-3 text-sm text-gray-700",
                              }),
                        "flex h-10 items-center justify-between",
                        variant === "glass" && LIQUID_GLASS_HOVER_CLASS,
                        (wrapLabels || selected?.suffix) &&
                            "h-auto min-h-10 py-2",
                        isOpen && variant === "glass" &&
                            LIQUID_GLASS_SELECTED_CLASS,
                        className,
                    )}
                >
                    <span className="flex min-w-0 items-center gap-2">
                        {selected?.icon && (
                            <selected.icon
                                className={cn(
                                    "h-3.5 w-3.5 shrink-0",
                                    selected.iconClassName,
                                )}
                            />
                        )}
                        <span
                            className={cn(
                                wrapLabels || selected?.suffix
                                    ? "min-w-0 whitespace-normal text-left [overflow-wrap:anywhere]"
                                    : "truncate",
                                !selected && !hasValue && "text-gray-400",
                            )}
                        >
                            {selected?.label ??
                                (hasValue ? value : placeholder)}
                            {selected?.suffix && (
                                <span className="font-normal text-gray-400">
                                    {" "}
                                    {selected.suffix}
                                </span>
                            )}
                        </span>
                    </span>
                    <ChevronDown
                        className={cn(
                            "ml-2 h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform",
                            isOpen && "rotate-180",
                        )}
                    />
                </button>
            </DropdownTrigger>
            {isOpen && !disabled && (
                <DropdownContent
                    align="start"
                    sideOffset={4}
                    collisionPadding={12}
                    onEscapeKeyDown={(event) => event.stopPropagation()}
                    className={cn(
                        "max-h-56 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-2xl p-1",
                        menuClassName,
                    )}
                >
                    {normalizedOptions.map((option) => (
                        <DropdownItem
                            key={option.value}
                            textValue={[option.label, option.suffix]
                                .filter(Boolean)
                                .join(" ")}
                            aria-label={
                                option.suffix
                                    ? `${option.label} ${option.suffix}`
                                    : undefined
                            }
                            selected={option.value === value}
                            onSelect={() => handleSelect(option.value)}
                            className={cn(
                                "w-full rounded-md py-2 text-left transition-all",
                                option.value === value
                                    ? "text-gray-900"
                                    : "text-gray-700",
                            )}
                        >
                            <span className="flex min-w-0 items-center gap-2">
                                {option.icon && (
                                    <option.icon
                                        className={cn(
                                            "h-3.5 w-3.5 shrink-0",
                                            option.iconClassName,
                                        )}
                                    />
                                )}
                                <span
                                    className={
                                        wrapLabels || option.suffix
                                            ? "min-w-0 whitespace-normal [overflow-wrap:anywhere]"
                                            : "truncate"
                                    }
                                >
                                    {option.label}
                                    {option.suffix && (
                                        <span className="font-normal text-gray-400">
                                            {" "}
                                            {option.suffix}
                                        </span>
                                    )}
                                </span>
                            </span>
                        </DropdownItem>
                    ))}
                </DropdownContent>
            )}
        </Dropdown>
    );
}
