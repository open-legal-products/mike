import type { ComponentType } from "react";
import { UserRound } from "lucide-react";
import {
  ChatSkeuoIcon,
  OrganizationSkeuoIcon,
  TabularReviewSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { ClosedProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";

export const HISTORY_APPLICATION_ICONS: Partial<
  Record<string, ComponentType<{ className?: string }>>
> = {
  assistant: ChatSkeuoIcon,
  project: ClosedProjectSvgIcon,
  word: ({ className }) => (
    <FileTypeIcon fileType="docx" className={className} />
  ),
  tabular: TabularReviewSkeuoIcon,
  workflows: WorkflowSkeuoIcon,
  account: ({ className }) => (
    <UserRound aria-hidden="true" className={className} />
  ),
  organization: OrganizationSkeuoIcon,
};

export function HistoryApplicationIcon({ surface }: { surface: string }) {
  const Icon = HISTORY_APPLICATION_ICONS[surface];
  return Icon ? <Icon className="h-4 w-4 shrink-0" /> : null;
}
