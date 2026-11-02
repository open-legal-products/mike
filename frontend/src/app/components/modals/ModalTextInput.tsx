"use client";

import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/app/lib/utils";

type ModalTextInputVariant = "glass" | "minimal";

type ModalTextInputProps = InputHTMLAttributes<HTMLInputElement> & {
    variant?: ModalTextInputVariant;
};

const variantClasses: Record<ModalTextInputVariant, string> = {
    glass: "h-10 w-full rounded-xl border border-white/70 bg-white px-3 text-sm text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.052),inset_0_1px_0_rgba(255,255,255,0.86),inset_0_-1px_0_rgba(255,255,255,0.58)] outline-none placeholder:text-gray-400 backdrop-blur-xl transition-colors disabled:cursor-not-allowed disabled:opacity-60",
    minimal:
        "w-full bg-transparent font-serif text-2xl text-gray-800 outline-none placeholder:text-gray-300 disabled:cursor-not-allowed disabled:text-gray-400",
};

export const ModalTextInput = forwardRef<HTMLInputElement, ModalTextInputProps>(
    ({ className, variant = "glass", ...props }, ref) => (
        <input
            ref={ref}
            className={cn(variantClasses[variant], className)}
            {...props}
        />
    ),
);

ModalTextInput.displayName = "ModalTextInput";
