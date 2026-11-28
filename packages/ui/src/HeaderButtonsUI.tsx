import {
    Children,
    isValidElement,
    type ButtonHTMLAttributes,
    type ComponentProps,
    type ReactNode,
    type Ref,
} from "react";
import {
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_PRESSED_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "./LiquidGlassUI";

/**
 * A group of header buttons. The fill is translucent, so a caller that floats
 * the group over scrolling content adds its own `backdrop-blur-*`; in-flow
 * groups on the solid page background do not need one. A group already on a
 * glass surface (a page sheet) is `plain`: no pill of its own, only the
 * buttons' hover fills, at the same size.
 */
export function HeaderButtonsUI({
    className = "",
    surface = "subtle",
    ...props
}: ComponentProps<"div"> & { surface?: "subtle" | "plain" }) {
    return (
        <div
            data-surface={surface}
            className={`flex shrink-0 items-center gap-2 rounded-full px-1 py-1 ${surface === "subtle" ? LIQUID_GLASS_SUBTLE_CLASS : ""} ${className}`}
            {...props}
        />
    );
}

export type HeaderButtonUIProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "className"
> & {
    children?: ReactNode;
    className?: string;
    iconOnly?: boolean;
    /** Passed through to the button (React 19 passes refs as props). */
    ref?: Ref<HTMLButtonElement>;
};

export function headerButtonClassName({
    iconOnly = false,
    collapsesToIcon = false,
    disabled = false,
    className = "",
}: {
    iconOnly?: boolean;
    /** Round, showing only its icon, below md; labelled from md up. */
    collapsesToIcon?: boolean;
    disabled?: boolean;
    className?: string;
} = {}) {
    return [
        "flex h-7 items-center justify-center rounded-full text-sm transition-colors disabled:cursor-default disabled:text-gray-300 disabled:hover:bg-transparent disabled:hover:text-gray-300",
        LIQUID_GLASS_HOVER_CLASS,
        LIQUID_GLASS_PRESSED_CLASS,
        iconOnly
            ? "w-7"
            : collapsesToIcon
              ? "w-7 gap-1.5 px-0 md:w-auto md:px-3"
              : "gap-1.5 px-3",
        disabled ? "cursor-default" : "cursor-pointer",
        "text-gray-500 hover:text-gray-900",
        className,
    ]
        .filter(Boolean)
        .join(" ");
}

/**
 * A header button. One with both an icon and a text label shows only its
 * icon on a small screen, where page actions share the top bar with the
 * sidebar toggle; the label stays as its accessible name. A button with only
 * text keeps it at every size, since it would have nothing left to show.
 */
export function HeaderButtonUI({
    children,
    className,
    iconOnly = false,
    disabled,
    type = "button",
    ...props
}: HeaderButtonUIProps) {
    const parts = Children.toArray(children);
    const isText = (part: unknown) =>
        typeof part === "string" || typeof part === "number";
    const collapsesToIcon =
        !iconOnly && parts.some(isText) && parts.some(isValidElement);
    return (
        <button
            type={type}
            disabled={disabled}
            className={headerButtonClassName({
                iconOnly,
                collapsesToIcon,
                disabled,
                className,
            })}
            {...props}
        >
            {collapsesToIcon
                ? parts.map((part, index) =>
                      isText(part) ? (
                          <span key={index} className="sr-only md:not-sr-only">
                              {part}
                          </span>
                      ) : (
                          part
                      ),
                  )
                : children}
        </button>
    );
}
