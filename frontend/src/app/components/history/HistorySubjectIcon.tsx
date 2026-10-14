import { FileText, KeyRound, UserRound } from "lucide-react";
import { UserAvatar, type UserAvatarSize } from "@/app/components/ui/user-avatar";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import {
  ChatSkeuoIcon,
  OrganizationSkeuoIcon,
  TabularReviewSkeuoIcon,
  WorkflowSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { ClosedProjectSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import type { AuditEvent } from "@/app/lib/mikeApi";
import { auditSubject, auditSubjectEmail } from "./auditPresentation";

export function HistorySubjectIcon({ event, avatarSize }: { event: AuditEvent; avatarSize?: UserAvatarSize }) {
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
  // Recipients without an authorized roster photo use the same monogram as
  // new share recipients. Never look up photos by an arbitrary event email.
  if (type === "Member" || type === "Recipient")
    return (
      <UserAvatar
        size={avatarSize}
        name={name === "-" || name.includes("@") ? null : name}
        email={auditSubjectEmail(event)}
      />
    );
  const Icon =
    type === "Account" ? UserRound : type === "Provider" ? KeyRound : FileText;
  return <Icon aria-hidden="true" className={className} />;
}
