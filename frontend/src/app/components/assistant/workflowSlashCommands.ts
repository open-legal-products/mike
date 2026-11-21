import type { Workflow } from "../shared/types";
import {
    slashCommandQueryFromValue,
    withoutSlashCommand,
    workflowSlashCommandFromTitle,
} from "@mike/ui";

export { withoutSlashCommand };

export function workflowSlashCommand(workflow: Workflow): string | null {
    return workflowSlashCommandFromTitle(workflow.metadata.title);
}

export function slashCommandQuery(value: string): string | null {
    return slashCommandQueryFromValue(value);
}

export function matchingSlashWorkflows(
    workflows: Workflow[],
    query: string | null,
): Workflow[] {
    if (query === null) return [];
    return workflows.filter((workflow) =>
        workflowSlashCommand(workflow)?.startsWith(query),
    );
}

export function exactSlashWorkflow(
    workflows: Workflow[],
    query: string,
): Workflow | undefined {
    const normalized = query.toLowerCase();
    return workflows.find(
        (workflow) => workflowSlashCommand(workflow) === normalized,
    );
}
