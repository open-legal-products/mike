import type { ReactNode } from "react";
import { LIQUID_GLASS_FLOAT_CLASS } from "@mike/ui";

export function TRExpandedCellSurface({ children }: { children: ReactNode }) {
    return (
        <div className={`absolute left-0 top-0 z-50 w-full rounded-xl ${LIQUID_GLASS_FLOAT_CLASS}`}>
            {children}
        </div>
    );
}
