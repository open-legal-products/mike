"use client";

import {
    useEffect,
    useState,
    type CSSProperties,
    type HTMLAttributes,
    type ComponentType,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { EmptyState } from "@/app/components/ui/empty-state";
import {
    DropdownMenu,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
    LiquidDropdownContent,
    LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import {
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_GROUP_HOVER_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    TABLE_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";

export const CLOSE_ROW_ACTIONS_EVENT = "mike:close-row-actions";

export function closeRowActionMenus() {
    document.dispatchEvent(new Event(CLOSE_ROW_ACTIONS_EVENT));
}

export function rowActionSelectionIds(
    rowId: string,
    selectedIds: readonly string[],
): string[] {
    return selectedIds.includes(rowId) ? [...selectedIds] : [rowId];
}

export function selectedIdsAfterShiftClick<T>(
    rowId: T,
    selectedIds: readonly T[],
): T[] {
    return selectedIds.includes(rowId)
        ? [...selectedIds]
        : [...selectedIds, rowId];
}

export function selectionRangeIds<T>(
    orderedIds: readonly T[],
    anchorId: T | null,
    targetId: T,
): T[] {
    const anchorIndex = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
    const targetIndex = orderedIds.indexOf(targetId);
    if (anchorIndex < 0 || targetIndex < 0) return [targetId];
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    return orderedIds.slice(start, end + 1);
}

export function selectionAnchorAfterRowSelection<T>(
    currentAnchorId: T | null,
    targetId: T,
    affectedIds: readonly T[],
    selected: boolean,
): T | null {
    if (selected) return targetId;
    return currentAnchorId !== null && affectedIds.includes(currentAnchorId)
        ? null
        : currentAnchorId;
}

export function selectedIdsAfterRangeClick<T>(
    targetId: T,
    orderedIds: readonly T[],
    selectedIds: readonly T[],
    anchorId: T | null,
): T[] {
    return [
        ...new Set([
            ...selectedIds,
            ...selectionRangeIds(orderedIds, anchorId, targetId),
        ]),
    ];
}

function canPortalToDocument() {
    return typeof document !== "undefined";
}

export const TABLE_PRIMARY_CELL_WIDTH_CLASS =
    "w-[248px] sm:w-[292px] md:w-[332px] shrink-0";
export const TABLE_CHECKBOX_CLASS =
    "mr-3 h-2.5 w-2.5 shrink-0 rounded border-gray-200 cursor-pointer accent-black";

// A child checkbox is centered beneath its parent folder's 16px chevron.
// Root padding is 12px; advancing one level crosses the 10px checkbox, its
// 12px margin, and half the 6px width difference between both controls.
const TABLE_TREE_ROOT_PADDING_PX = 12;
const TABLE_TREE_DEPTH_INDENT_PX = 25;

export function tableTreeCellStyle(
    depth: number,
): CSSProperties | undefined {
    if (depth <= 0) return undefined;
    return {
        paddingLeft:
            TABLE_TREE_ROOT_PADDING_PX + depth * TABLE_TREE_DEPTH_INDENT_PX,
    };
}

type DivProps = HTMLAttributes<HTMLDivElement>;

export type TableFilterOption<T extends string> = {
    value: T;
    label: string;
    icon?: ComponentType<{ className?: string }>;
    className?: string;
};

export type TableSortDirection = "asc" | "desc";

export function TableFilters<T extends string>({
    label,
    value,
    allLabel,
    options,
    onChange,
    widthClassName = "w-52",
    align = "left",
}: {
    label: string;
    value: T | null;
    allLabel: string;
    options: TableFilterOption<T>[];
    onChange: (value: T | null) => void;
    widthClassName?: string;
    /**
     * Which side the menu opens toward. "left" (default) anchors the menu's
     * right edge to the button and extends leftward; "right" anchors the menu's
     * left edge to the button and extends rightward.
     */
    align?: "left" | "right";
}) {
    const [open, setOpen] = useState(false);
    const selected = options.find((option) => option.value === value);

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={label}
                    title={selected?.label ?? label}
                    className={`flex h-[18px] w-[22px] items-center justify-center rounded-sm transition-colors ${
                        value
                            ? `text-gray-700 ${LIQUID_GLASS_HOVER_CLASS} hover:text-gray-900`
                            : `text-gray-400 ${LIQUID_GLASS_HOVER_CLASS} hover:text-gray-700`
                    }`}
                >
                    <ChevronDown
                        className={`h-3 w-3 transition-transform ${
                            open ? "rotate-180" : ""
                        }`}
                    />
                </button>
            </DropdownMenuTrigger>
            <LiquidDropdownContent
                align={align === "right" ? "start" : "end"}
                className={`z-[120] overflow-hidden ${widthClassName}`}
            >
                <LiquidDropdownItem
                    selected={value === null}
                    onSelect={() => onChange(null)}
                    className="flex w-full items-center justify-between px-3 py-2"
                >
                    {allLabel}
                    {!value && <Check className="h-3.5 w-3.5 text-gray-400" />}
                </LiquidDropdownItem>
                {options.length > 0 && (
                    <DropdownMenuSeparator className="-mx-1 my-1 bg-white/60" />
                )}
                {options.map((option) => {
                    const Icon = option.icon;

                    return (
                        <LiquidDropdownItem
                            key={option.value}
                            selected={value === option.value}
                            onSelect={() => onChange(option.value)}
                            className="flex w-full items-center justify-between px-3 py-2"
                        >
                            <span
                                className={`truncate pr-2 ${
                                    Icon
                                        ? "inline-flex items-center gap-1.5 font-medium"
                                        : ""
                                } ${option.className ?? ""}`}
                            >
                                {Icon && (
                                    <Icon className="h-3.5 w-3.5 shrink-0" />
                                )}
                                {option.label}
                            </span>
                            {value === option.value && (
                                <Check className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                            )}
                        </LiquidDropdownItem>
                    );
                })}
            </LiquidDropdownContent>
        </DropdownMenu>
    );
}

export function SkeletonLine({ className }: { className?: string }) {
    return (
        <div
            className={cn("h-3 rounded bg-gray-100 animate-pulse", className)}
        />
    );
}

export function SkeletonCheckbox({ className }: { className?: string }) {
    return (
        <div
            aria-hidden="true"
            className={cn(
                "mr-3 h-2.5 w-2.5 shrink-0 rounded bg-gray-100 animate-pulse",
                className,
            )}
        />
    );
}

export function TableScrollArea({
    children,
    className,
    header,
    viewportOverlay,
    preserveGridBorder = false,
    scrollRef,
    onScroll,
}: DivProps & {
    header?: ReactNode;
    viewportOverlay?: ReactNode;
    preserveGridBorder?: boolean;
    scrollRef?: RefObject<HTMLDivElement | null>;
}) {
    return (
        <div
            className={cn(
                // A narrower gutter than the page header and toolbar, because
                // the row's own `pl-3` sits inside it: the selection checkbox
                // is what has to line up with the header text and the tab
                // pills, not the table's box.
                "mx-4 mb-2 min-h-0 min-w-0 flex-1 rounded-2xl md:mx-6 md:mb-3",
                className,
            )}
        >
            <div
                className={cn(
                    "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
                    TABLE_SURFACE_CLASS,
                    preserveGridBorder && "tabular-review-table-surface",
                )}
            >
                <div className="relative flex min-h-0 min-w-0 flex-1">
                    <div
                        ref={scrollRef}
                        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto overscroll-x-none"
                        onScroll={onScroll}
                    >
                        {header && (
                            <div className="table-sticky-header sticky top-0 z-[70] w-max min-w-full shrink-0">
                                {header}
                            </div>
                        )}
                        {children}
                    </div>
                    {viewportOverlay}
                </div>
            </div>
        </div>
    );
}

export function TableHeaderRow({ children, className, ...props }: DivProps) {
    return (
        <div
            className={cn(
                "z-[70] flex h-10 min-w-max items-center pr-3 text-xs font-medium text-gray-700 select-none",
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}

export function TableRow({
    children,
    className,
    interactive = true,
    selected = false,
    onContextMenu,
    rightClickDropdown,
    ...props
}: DivProps & {
    interactive?: boolean;
    selected?: boolean;
    rightClickDropdown?:
        | ReactNode
        | ((close: () => void, menuProps: DivProps) => ReactNode);
}) {
    const [menuCoords, setMenuCoords] = useState<{
        top: number;
        left: number;
    } | null>(null);

    useEffect(() => {
        if (!menuCoords) return;
        function handleClick() {
            setMenuCoords(null);
        }
        function handleCloseRowActions() {
            setMenuCoords(null);
        }
        document.addEventListener("click", handleClick);
        document.addEventListener(
            CLOSE_ROW_ACTIONS_EVENT,
            handleCloseRowActions,
        );
        return () => {
            document.removeEventListener("click", handleClick);
            document.removeEventListener(
                CLOSE_ROW_ACTIONS_EVENT,
                handleCloseRowActions,
            );
        };
    }, [menuCoords]);

    function closeRightClickDropdown() {
        setMenuCoords(null);
    }

    function handleContextMenu(e: ReactMouseEvent<HTMLDivElement>) {
        onContextMenu?.(e);
        if (!rightClickDropdown || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        closeRowActionMenus();
        const menuWidth = 192;
        setMenuCoords({
            top: e.clientY,
            left: Math.min(e.clientX, window.innerWidth - menuWidth - 8),
        });
    }

    return (
        <>
            <div
                className={cn(
                    "group flex h-10 min-w-max items-center pr-3 transition-colors",
                    interactive && "cursor-pointer",
                    interactive && !selected && LIQUID_GLASS_HOVER_CLASS,
                    selected && LIQUID_GLASS_SELECTED_CLASS,
                    className,
                )}
                onContextMenu={handleContextMenu}
                {...props}
            >
                {children}
            </div>
            {menuCoords &&
                rightClickDropdown &&
                canPortalToDocument() &&
                createPortal(
                    typeof rightClickDropdown === "function"
                        ? rightClickDropdown(closeRightClickDropdown, {
                              style: {
                                  position: "fixed",
                                  top: menuCoords.top,
                                  left: menuCoords.left,
                              },
                              className: "z-[120]",
                              onClick: (e) => e.stopPropagation(),
                              onContextMenu: (e) => e.preventDefault(),
                          })
                        : rightClickDropdown,
                    document.body,
                )}
        </>
    );
}

export function TableStickyCell({
    children,
    className,
    style,
    widthClassName = TABLE_PRIMARY_CELL_WIDTH_CLASS,
    bgClassName,
    header = false,
    hover = true,
}: DivProps & {
    widthClassName?: string;
    bgClassName?: string;
    header?: boolean;
    hover?: boolean;
}) {
    return (
        <div
            style={style}
            className={cn(
                "sticky left-0 z-[60] flex pl-3 pr-2 text-left",
                "table-sticky-cell",
                widthClassName,
                bgClassName,
                header
                    ? "z-[80] items-center self-stretch"
                    : "py-2 transition-colors",
                !header && hover && LIQUID_GLASS_GROUP_HOVER_CLASS,
                className,
            )}
        >
            {children}
        </div>
    );
}

export function TablePrimaryCell({
    children,
    className,
    style,
    widthClassName = TABLE_PRIMARY_CELL_WIDTH_CLASS,
    bgClassName,
    selected,
    onSelectionChange,
    selectionIndicator,
    checkboxTitle,
    label,
    editing = false,
    editValue,
    onEditValueChange,
    onEditCommit,
    onEditCancel,
}: DivProps & {
    widthClassName?: string;
    bgClassName?: string;
    selected: boolean;
    onSelectionChange: () => void;
    selectionIndicator?: ReactNode;
    checkboxTitle?: string;
    label?: ReactNode;
    editing?: boolean;
    editValue?: string;
    onEditValueChange?: (value: string) => void;
    onEditCommit?: () => void;
    onEditCancel?: () => void;
}) {
    const content =
        label !== undefined ? (
            editing ? (
                <input
                    autoFocus
                    value={editValue ?? ""}
                    onChange={(e) => onEditValueChange?.(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") onEditCommit?.();
                        if (e.key === "Escape") onEditCancel?.();
                    }}
                    onBlur={onEditCommit}
                    onClick={(e) => e.stopPropagation()}
                    className="min-w-0 flex-1 text-xs text-gray-800 bg-transparent outline-none"
                />
            ) : (
                <span className="min-w-0 flex-1 truncate text-xs text-gray-800">
                    {label}
                </span>
            )
        ) : (
            children
        );

    return (
        <TableStickyCell
            style={style}
            widthClassName={widthClassName}
            bgClassName={selected ? LIQUID_GLASS_SELECTED_CLASS : bgClassName}
            className={className}
            hover={!selected}
        >
            <div className="flex min-w-0 items-center">
                {selectionIndicator ?? (
                    <input
                        type="checkbox"
                        checked={selected}
                        onChange={onSelectionChange}
                        onClick={(e) => e.stopPropagation()}
                        className={TABLE_CHECKBOX_CLASS}
                        title={checkboxTitle}
                        aria-label={
                            checkboxTitle ??
                            (typeof label === "string"
                                ? `Select ${label}`
                                : undefined)
                        }
                    />
                )}
                {content}
            </div>
        </TableStickyCell>
    );
}

export function TableHeaderCell({ children, className, ...props }: DivProps) {
    return (
        <div
            className={cn("flex shrink-0 items-center text-left", className)}
            {...props}
        >
            {children}
        </div>
    );
}

export function TableCell({ children, className, ...props }: DivProps) {
    return (
        <div
            className={cn("shrink-0 truncate text-xs text-gray-500", className)}
            {...props}
        >
            {children}
        </div>
    );
}

export function TableBody({ children, className, ...props }: DivProps) {
    return (
        <div className={cn("flex-1", className)} {...props}>
            {children}
        </div>
    );
}

export function TableEmptyState({
    children,
    className,
}: {
    children: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "mx-auto flex w-full max-w-[260px] flex-1 flex-col items-start justify-center py-24 text-left",
                className,
            )}
        >
            {children}
        </div>
    );
}

/**
 * A table that could not load, with the one way back: "Try again".
 *
 * The in-table half of `docs/design-system.md` ("Reporting failures") — a
 * screen that cannot render says so in place, instead of showing an empty
 * table that reads as "you have nothing here". Pass the section's own icon
 * and heading so it still looks like the screen the user asked for.
 */
export function TableErrorState({
    icon,
    title,
    message,
    onRetry,
    retryLabel = "Try again",
    className,
}: {
    icon?: ReactNode;
    title: ReactNode;
    message: ReactNode;
    onRetry: () => void | Promise<void>;
    retryLabel?: string;
    className?: string;
}) {
    return (
        <TableEmptyState className={className}>
            <EmptyState
                icon={icon}
                title={title}
                description={message}
                tone="error"
                action={
                    <button
                        type="button"
                        onClick={() => void onRetry()}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-700 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    >
                        <Loader2 className="h-3.5 w-3.5" />
                        {retryLabel}
                    </button>
                }
            />
        </TableEmptyState>
    );
}
