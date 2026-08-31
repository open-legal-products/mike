import type { Story } from "@ladle/react";
import {
    LIQUID_FLOAT_PANEL_SURFACE_CLASS,
    LIQUID_GLASS_FLAT_CLASS,
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_MODAL_CLASS,
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
    LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS,
    LIQUID_GLASS_PRESSED_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
    LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS,
    LIQUID_GLASS_TRANSLUCENT_CLASS,
    LIQUID_SUBTLE_PANEL_SURFACE_CLASS,
    LIQUID_TABLE_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";

export default { title: "UI / LiquidSurface" };

const MATERIALS: [label: string, className: string][] = [
    ["liquid-glass-flat", LIQUID_GLASS_FLAT_CLASS],
    ["liquid-glass-subtle", LIQUID_GLASS_SUBTLE_CLASS],
    ["liquid-glass-float", LIQUID_GLASS_FLOAT_CLASS],
    ["liquid-glass-modal", LIQUID_GLASS_MODAL_CLASS],
    ["liquid-glass-translucent", LIQUID_GLASS_TRANSLUCENT_CLASS],
];

const PANELS: [label: string, className: string][] = [
    ["LIQUID_TABLE_SURFACE_CLASS", LIQUID_TABLE_SURFACE_CLASS],
    ["LIQUID_SUBTLE_PANEL_SURFACE_CLASS", LIQUID_SUBTLE_PANEL_SURFACE_CLASS],
    ["LIQUID_FLOAT_PANEL_SURFACE_CLASS", LIQUID_FLOAT_PANEL_SURFACE_CLASS],
];

const STATES: [label: string, className: string][] = [
    ["liquid-glass-hover", LIQUID_GLASS_HOVER_CLASS],
    ["liquid-glass-selected", LIQUID_GLASS_SELECTED_CLASS],
    ["liquid-glass-pressed", LIQUID_GLASS_PRESSED_CLASS],
];

/**
 * `liquid-surface.ts` is class-name constants rather than a component, but the
 * elevation ladder is the hardest part of the design system to hold in your
 * head from prose alone. Each material owns its own fill, border and shadow —
 * never hand-write a `shadow-[...]` recipe for a glass surface.
 *
 * Use the theme toggle: every tier has a distinct dark value.
 */
export const Materials: Story = () => (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {MATERIALS.map(([label, className]) => (
            <div
                key={label}
                className={`flex h-24 items-end rounded-2xl p-3 text-xs ${className}`}
            >
                <code>{label}</code>
            </div>
        ))}
    </div>
);

/** The pre-composed panel/table surfaces, radius included. */
export const PanelSurfaces: Story = () => (
    <div className="flex flex-col gap-4">
        {PANELS.map(([label, className]) => (
            <div key={label} className={`p-4 text-xs ${className}`}>
                <code>{label}</code>
            </div>
        ))}
    </div>
);

/**
 * Interactive colour is separate from elevation, so one state treatment works
 * across every tier. Hover the rows.
 */
export const InteractiveStates: Story = () => (
    <div className={`flex flex-col gap-1 p-2 ${LIQUID_SUBTLE_PANEL_SURFACE_CLASS}`}>
        {STATES.map(([label, className]) => (
            <div
                key={label}
                className={`rounded-lg px-3 py-2 text-xs ${className}`}
            >
                <code>{label}</code>
            </div>
        ))}
    </div>
);

/**
 * The modal row pair is intentionally distinct because `liquid-glass-modal`
 * has a darker resting fill. It is for selectable list rows on a modal frame —
 * not for inputs or buttons that merely happen to sit inside a modal.
 */
export const ModalRows: Story = () => (
    <div
        className={`flex flex-col gap-1 rounded-2xl p-3 ${LIQUID_GLASS_MODAL_CLASS}`}
    >
        <div
            className={`rounded-lg px-3 py-2 text-xs ${LIQUID_GLASS_MODAL_ROW_HOVER_CLASS}`}
        >
            <code>liquid-glass-modal-row-hover</code>
        </div>
        <div
            className={`rounded-lg px-3 py-2 text-xs ${LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS}`}
        >
            <code>liquid-glass-modal-row-selected</code>
        </div>
    </div>
);

/**
 * The translucent action modifier is used with the translucent material for
 * compact over-message controls such as scroll-to-bottom.
 */
export const TranslucentAction: Story = () => (
    <div className="rounded-2xl bg-gradient-to-br from-blue-100 to-blue-200 p-8">
        <div
            className={`inline-flex rounded-full px-3 py-1.5 text-xs ${LIQUID_GLASS_TRANSLUCENT_CLASS} ${LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS}`}
        >
            <code>+ translucent-action</code>
        </div>
    </div>
);
