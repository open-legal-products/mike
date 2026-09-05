import { cn } from "@/app/lib/utils";
import { Loader2 } from "lucide-react";

type SettingsToggleSize = "sm" | "md";

const sizeClasses: Record<
    SettingsToggleSize,
    {
        track: string;
        thumb: string;
        translate: string;
    }
> = {
    sm: {
        track: "h-4 w-7 p-0.5",
        thumb: "h-3 w-3",
        translate: "translate-x-3",
    },
    md: {
        track: "h-5 w-9 p-0.5",
        thumb: "h-4 w-4",
        translate: "translate-x-4",
    },
};

export function SettingsToggle({
    checked,
    disabled,
    loading,
    onChange,
    size = "sm",
    label,
    ariaLabel,
    className,
}: {
    checked: boolean;
    disabled?: boolean;
    loading?: boolean;
    onChange: (checked: boolean) => void;
    size?: SettingsToggleSize;
    label?: string;
    ariaLabel?: string;
    className?: string;
}) {
    const sizes = sizeClasses[size];
    const button = (
        <button
            type="button"
            role="switch"
            aria-label={ariaLabel}
            aria-checked={checked}
            disabled={disabled || loading}
            onClick={() => onChange(!checked)}
            className={cn(
                "flex shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2",
                checked
                    ? "bg-emerald-600"
                    : "bg-gray-300 ring-1 ring-inset ring-gray-400",
                "disabled:cursor-not-allowed disabled:opacity-40",
                sizes.track,
            )}
        >
            <span
                className={cn(
                    "flex items-center justify-center rounded-full bg-white shadow-sm transition-transform",
                    sizes.thumb,
                    checked ? sizes.translate : "translate-x-0",
                )}
            >
                {loading && (
                    <Loader2 className="h-2.5 w-2.5 animate-spin text-gray-400" />
                )}
            </span>
        </button>
    );

    if (!label) return button;

    return (
        <label
            className={cn(
                "inline-flex shrink-0 items-center gap-1.5 text-xs font-medium",
                checked ? "text-emerald-700" : "text-gray-500",
                className,
            )}
        >
            <span>{label}</span>
            {button}
        </label>
    );
}
