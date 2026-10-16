import { getImageProps } from "next/image";
import { preload } from "react-dom";
import { SvgAssetIcon, type SvgAssetIconProps } from "@/app/components/ui/svg-asset-icon";
import chat from "../../../../public/icons/features/chat.svg";
import chatComplete from "../../../../public/icons/features/chat-complete.svg";
import ide from "../../../../public/icons/features/ide.svg";
import project from "../../../../public/icons/file-system/project-closed.svg";
import library from "../../../../public/icons/features/library.svg";
import tabularReview from "../../../../public/icons/features/tabular-review.svg";
import tabularReviewComplete from "../../../../public/icons/features/tabular-review-complete.svg";
import workflow from "../../../../public/icons/features/workflow.svg";
import connector from "../../../../public/icons/features/connector.svg";
import organization from "../../../../public/icons/features/organization.svg";
import settings from "../../../../public/icons/settings.svg";
import signOut from "../../../../public/icons/sign-out.svg";

type IconProps = Omit<SvgAssetIconProps, "width" | "height">;

const icons = {
  "features/chat": chat,
  "features/chat-complete": chatComplete,
  "features/ide": ide,
  "file-system/project-closed": project,
  "features/library": library,
  "features/tabular-review": tabularReview,
  "features/tabular-review-complete": tabularReviewComplete,
  "features/workflow": workflow,
  "features/connector": connector,
  "features/organization": organization,
  settings,
  "sign-out": signOut,
};

/** Warm navigation and account-menu icons before authentication finishes. */
export function preloadSidebarIcons() {
  for (const src of [
    chat, chatComplete, ide, project, library, tabularReview, tabularReviewComplete, workflow,
    settings, organization, signOut,
  ]) {
    const { props } = getImageProps({
      src, alt: "", width: 64, height: 64, unoptimized: true,
    });
    preload(props.src, { as: "image", type: "image/svg+xml" });
  }
}

function AppSidebarIcon({ name, ...props }: IconProps & { name: keyof typeof icons }) {
  return <SvgAssetIcon src={icons[name]} {...props} />;
}

export function ChatSkeuoIcon({
  className,
  tone = "blue",
  ...props
}: IconProps & { tone?: "blue" | "green" }) {
  return (
    <AppSidebarIcon
      name={tone === "green" ? "features/chat-complete" : "features/chat"}
      className={className}
      {...props}
    />
  );
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

export function TabularReviewCompleteIcon(props: IconProps) {
  return <AppSidebarIcon name="features/tabular-review-complete" {...props} />;
}

export function WorkflowSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="features/workflow" {...props} />;
}

export function ConnectorSkeuoIcon(props: IconProps) {
  return <AppSidebarIcon name="features/connector" {...props} />;
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
