import Image, { type ImageProps } from "next/image";

type IconProps = Omit<
  ImageProps,
  "alt" | "src" | "width" | "height" | "unoptimized"
>;

const ICON_BASE_PATH = "/icons";
const ICON_VERSION = "44";

function AppSidebarIcon({
  name,
  className,
  ...props
}: IconProps & { name: string }) {
  return (
    <Image
      src={`${ICON_BASE_PATH}/${name}.svg?v=${ICON_VERSION}`}
      alt=""
      width={64}
      height={64}
      unoptimized
      aria-hidden="true"
      draggable={false}
      className={`${className ?? ""} object-contain`}
      {...props}
    />
  );
}

export function ChatSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="features/chat" {...props} />;
}

export function IdeSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="features/ide" {...props} />;
}

export function FolderSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="file-system/project-closed" {...props} />;
}

export function LibrarySkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="features/library" {...props} />;
}

export function TabularReviewSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="features/tabular-review" {...props} />;
}

export function WorkflowSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="features/workflow" {...props} />;
}

export function OrganizationSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="features/organization" {...props} />;
}

export function SettingsSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="settings" {...props} />;
}

export function SignOutSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="sign-out" {...props} />;
}
