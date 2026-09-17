import { WorkflowSlashCommandUI } from "@/shared/ui/WorkflowSlashCommandUI";

const meta = { title: "Shared UI / WorkflowSlashCommand" };
export default meta;

export const GeneratedCommand = () => (
    <WorkflowSlashCommandUI title="Review limitation of liability" />
);

export const UnicodeTitle = () => (
    <WorkflowSlashCommandUI title="合同をレビュー" />
);

export const EmptyTitle = () => <WorkflowSlashCommandUI title="" />;
