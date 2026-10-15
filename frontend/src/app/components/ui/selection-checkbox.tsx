"use client";

import { useEffect, useRef } from "react";
import { TABLE_CHECKBOX_CLASS } from "@/app/components/shared/TablePrimitive";
import { cn } from "@/app/lib/utils";

/** Compact native selection control shared by directory and project picker rows. */
export function SelectionCheckbox({
    checked,
    disabled = false,
    indeterminate = false,
    label,
    onChange,
}: {
    checked: boolean;
    disabled?: boolean;
    indeterminate?: boolean;
    label: string;
    onChange: () => void;
}) {
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (inputRef.current) inputRef.current.indeterminate = indeterminate;
    }, [indeterminate]);

    return (
        <input
            ref={inputRef}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={onChange}
            aria-checked={indeterminate ? "mixed" : checked}
            aria-label={label}
            className={cn(TABLE_CHECKBOX_CLASS, "mr-0 justify-self-center disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2")}
        />
    );
}
