import { SvgAssetIcon, type SvgAssetIconProps } from "@/app/components/ui/svg-asset-icon";
import history from "../../../../public/icons/features/history.svg";

type IconProps = Omit<SvgAssetIconProps, "width" | "height">;

/** History icon uses the same immediate, cacheable loading as other UI icons. */
export function HistorySkeuoIcon(props: IconProps) {
    return <SvgAssetIcon src={history} {...props} />;
}
