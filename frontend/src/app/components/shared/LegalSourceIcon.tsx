import type { StaticImageData } from "next/image";
import { SvgAssetIcon } from "@/app/components/ui/svg-asset-icon";
import caseLaw from "../../../../public/icons/legal-sources/case-law.svg";
import legislation from "../../../../public/icons/legal-sources/legislation.svg";
import type { LegalSourceIconKind } from "./documentCapabilities";

const ICONS: Record<LegalSourceIconKind, StaticImageData> = {
    case: caseLaw,
    legislation,
};

/** The decorative icon of a legal source, in tabs, title rows and citations. */
export function LegalSourceIcon({
    kind,
    className = "h-3.5 w-3.5 shrink-0",
}: {
    kind: LegalSourceIconKind;
    className?: string;
}) {
    return (
        <SvgAssetIcon
            src={ICONS[kind]}
            aria-hidden="true"
            width={14}
            height={14}
            className={className}
        />
    );
}
