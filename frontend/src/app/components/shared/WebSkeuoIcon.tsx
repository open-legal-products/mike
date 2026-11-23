import { SvgAssetIcon, type SvgAssetIconProps } from "@/app/components/ui/svg-asset-icon";
import earth from "../../../../public/icons/earth.svg";

type IconProps = Omit<SvgAssetIconProps, "width" | "height">;

/** The globe beside the assistant's web searches and page reads. */
export function WebSkeuoIcon(props: IconProps) {
    return <SvgAssetIcon src={earth} {...props} />;
}
