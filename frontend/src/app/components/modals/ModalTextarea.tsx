"use client";

import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/app/lib/utils";
import { FORM_CONTROL_GLASS_CLASS } from "../ui/form-field";

type ModalTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const ModalTextarea = forwardRef<
    HTMLTextAreaElement,
    ModalTextareaProps
>(({ className, ...props }, ref) => (
    <textarea
        ref={ref}
        className={cn(
            FORM_CONTROL_GLASS_CLASS,
            "min-h-24 resize-none py-2.5 leading-relaxed",
            className,
        )}
        {...props}
    />
));

ModalTextarea.displayName = "ModalTextarea";
