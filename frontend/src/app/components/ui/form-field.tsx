"use client";

import {
    forwardRef,
    type HTMLAttributes,
    type InputHTMLAttributes,
    type ReactNode,
} from "react";
import { cn } from "@/app/lib/utils";
import { LIQUID_GLASS_SUBTLE_CLASS } from "@/shared/ui/LiquidGlassUI";

// `outline-none` removes the browser's focus indicator, so every variant has to
// supply its own `focus-visible:` ring or the field becomes unusable by keyboard.
const FOCUS_RING_CLASS =
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2";

export const FORM_CONTROL_GLASS_CLASS =
    `w-full rounded-xl px-3 text-sm text-gray-700 ${LIQUID_GLASS_SUBTLE_CLASS} outline-none placeholder:text-gray-400 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING_CLASS}`;

type FormTextInputVariant = "glass" | "minimal";

type FormTextInputProps = InputHTMLAttributes<HTMLInputElement> & {
    variant?: FormTextInputVariant;
};

const variantClasses: Record<FormTextInputVariant, string> = {
    glass: cn("h-10", FORM_CONTROL_GLASS_CLASS),
    // A modal's large title field: keyboard-focus-ring (globals.css, driven
    // by useInputModality) drops the ring after a click or an autofocus that
    // followed one, keeping it for Tab navigation.
    minimal: cn(
        "w-full rounded bg-transparent font-serif text-2xl text-gray-800 outline-none placeholder:text-gray-300 disabled:cursor-not-allowed disabled:text-gray-400",
        FOCUS_RING_CLASS,
        "keyboard-focus-ring",
    ),
};

export const FormTextInput = forwardRef<HTMLInputElement, FormTextInputProps>(
    ({ className, variant = "glass", ...props }, ref) => (
        <input
            ref={ref}
            className={cn(variantClasses[variant], className)}
            {...props}
        />
    ),
);

FormTextInput.displayName = "FormTextInput";

// Element-agnostic so the same props spread onto a label, p or span.
type FieldLabelProps = Omit<HTMLAttributes<HTMLElement>, "className"> & {
    children: ReactNode;
    as?: "label" | "p" | "span";
    htmlFor?: string;
};

export function FieldLabel({
    as: Component = "label",
    children,
    htmlFor,
    ...props
}: FieldLabelProps) {
    return (
        <Component
            className="mb-2 block text-sm font-medium text-gray-700"
            htmlFor={Component === "label" ? htmlFor : undefined}
            {...props}
        >
            {children}
        </Component>
    );
}
