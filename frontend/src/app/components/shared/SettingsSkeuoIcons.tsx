import { SvgAssetIcon, type SvgAssetIconProps } from "@/app/components/ui/svg-asset-icon";
import account from "../../../../public/icons/settings/account.svg";
import activity from "../../../../public/icons/settings/activity.svg";
import appearance from "../../../../public/icons/settings/appearance.svg";
import auditLog from "../../../../public/icons/settings/audit-log.svg";
import features from "../../../../public/icons/settings/features.svg";
import general from "../../../../public/icons/settings/general.svg";
import keys from "../../../../public/icons/settings/keys.svg";
import members from "../../../../public/icons/settings/members.svg";
import memory from "../../../../public/icons/settings/memory.svg";
import models from "../../../../public/icons/settings/models.svg";
import personalisation from "../../../../public/icons/settings/personalisation.svg";
import privacy from "../../../../public/icons/settings/privacy.svg";
import security from "../../../../public/icons/settings/security.svg";

// The sections of a person's Settings and of an organization's, shown on
// each area's overview page.

type IconProps = Omit<SvgAssetIconProps, "width" | "height">;

export const MemorySkeuoIcon = (props: IconProps) => <SvgAssetIcon src={memory} {...props} />;
export const FeaturesSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={features} {...props} />;
export const ModelsSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={models} {...props} />;
export const KeysSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={keys} {...props} />;
export const PrivacySkeuoIcon = (props: IconProps) => <SvgAssetIcon src={privacy} {...props} />;
export const AccountSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={account} {...props} />;
export const PersonalisationSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={personalisation} {...props} />;
export const AppearanceSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={appearance} {...props} />;
export const SecuritySkeuoIcon = (props: IconProps) => <SvgAssetIcon src={security} {...props} />;
export const ActivitySkeuoIcon = (props: IconProps) => <SvgAssetIcon src={activity} {...props} />;
export const GeneralSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={general} {...props} />;
export const MembersSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={members} {...props} />;
export const AuditLogSkeuoIcon = (props: IconProps) => <SvgAssetIcon src={auditLog} {...props} />;
