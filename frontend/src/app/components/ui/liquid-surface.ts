import {
    LIQUID_GLASS_FLAT_CLASS,
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
} from "@/shared/ui/LiquidGlassUI";

export const TABLE_SURFACE_CLASS =
    "table-surface rounded-2xl";

/**
 * The container for a text editor. It deliberately does NOT use
 * `TABLE_SURFACE_CLASS`: table containers are intentionally transparent, while
 * a surface someone is typing into remains visually raised.
 */
export const EDITOR_SURFACE_CLASS = `rounded-2xl ${LIQUID_GLASS_FLAT_CLASS}`;

export const LIQUID_FLOAT_PANEL_SURFACE_CLASS =
    `rounded-2xl ${LIQUID_GLASS_FLOAT_CLASS}`;

export const LIQUID_SUBTLE_PANEL_SURFACE_CLASS =
    `rounded-2xl ${LIQUID_GLASS_SUBTLE_CLASS}`;

export {
    LIQUID_GLASS_FLAT_CLASS,
    LIQUID_GLASS_FLOAT_CLASS,
    LIQUID_GLASS_GROUP_HOVER_CLASS,
    LIQUID_GLASS_HOVER_CLASS,
    LIQUID_GLASS_MODAL_CLASS,
    LIQUID_GLASS_MODAL_ROW_HOVER_CLASS,
    LIQUID_GLASS_MODAL_ROW_SELECTED_CLASS,
    LIQUID_GLASS_PRESSED_CLASS,
    LIQUID_GLASS_SELECTED_CLASS,
    LIQUID_GLASS_SUBTLE_CLASS,
    LIQUID_GLASS_TRANSLUCENT_ACTION_CLASS,
    LIQUID_GLASS_TRANSLUCENT_CLASS,
} from "@/shared/ui/LiquidGlassUI";
