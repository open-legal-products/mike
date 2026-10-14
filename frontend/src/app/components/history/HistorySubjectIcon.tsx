import { FileText, KeyRound, Mail, UserRound } from "lucide-react";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import {
  ChatSkeuoIcon,
  OrganizationSkeuoIcon,
  TabularReviewSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ClosedProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import type { AuditEvent } from "@/app/lib/mikeApi";
import { auditSubject } from "./auditPresentation";

export function HistorySubjectIcon({ event }: { event: AuditEvent }) {
  const { type, name } = auditSubject(event);
  const className = "h-4 w-4 shrink-0";
  if (type === "Document")
    return (
      <FileTypeIcon
        fileType={
          typeof event.detail?.file_type === "string"
            ? event.detail.file_type
            : name
        }
        className={className}
      />
    );
  if (type === "Chat" || type === "Chats")
    return <ChatSkeuoIcon className={className} />;
  if (type === "Organization")
    return <OrganizationSkeuoIcon className={className} />;
  if (type === "Review" || type === "Tabular Review")
    return <TabularReviewSkeuoIcon className={className} />;
  if (type === "Workflow") return <WorkflowSkeuoIcon className={className} />;
  if (type === "Project") return <ClosedProjectSvgIcon className={className} />;
  const Icon =
    type === "Member" || type === "Account"
      ? UserRound
      : type === "Recipient"
        ? Mail
        : type === "Provider"
          ? KeyRound
          : FileText;
  return <Icon aria-hidden="true" className={className} />;
}
