import type { ReactNode } from "react";
import { LIQUID_GLASS_FLAT_CLASS } from "./LiquidGlassUI";

/**
 * Canonical liquid-glass card surface.
 *
 * No backdrop blur: the flat material is an opaque fill, so the blur never
 * showed through while still costing a compositing layer per card.
 */
export function GlassCardUI({ children }: { children: ReactNode }) {
    return (
        <div className={`rounded-xl ${LIQUID_GLASS_FLAT_CLASS}`}>
            {children}
        </div>
    );
}
