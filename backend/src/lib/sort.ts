export type TabularReviewSortKey = "name" | "columns" | "documents" | "created" | "updated";
export type TabularReviewSortDirection = "asc" | "desc";

export interface TabularReviewSort {
    key: TabularReviewSortKey;
    direction: TabularReviewSortDirection;
}

const SUPPORTED_KEYS: TabularReviewSortKey[] = [
  "name",
  "columns",
  "documents",
  "created",
  "updated",
];

export function parseTabularReviewSort(
  value: Record<string, unknown>,
): TabularReviewSort {
    const rawKey = typeof value.sort_key === "string"
        ? value.sort_key
        : typeof value.key === "string"
            ? value.key
            : null;
    const key = rawKey && SUPPORTED_KEYS.includes(rawKey as TabularReviewSortKey)
        ? (rawKey as TabularReviewSortKey)
        : "created";
    const direction = value.sort_direction === "asc" || value.direction === "asc" ? "asc" : "desc";

    return { key, direction };
}

export type ProjectSortKey =
  | "name"
  | "cm"
  | "files"
  | "chats"
  | "reviews"
  | "created"
  | "updated";
export type ProjectSortDirection = "asc" | "desc";

export interface ProjectSort {
    key: ProjectSortKey;
    direction: ProjectSortDirection;
}

const PROJECT_SUPPORTED_KEYS: ProjectSortKey[] = [
  "name",
  "cm",
  "files",
  "chats",
  "reviews",
  "created",
  "updated",
];

export function parseProjectSort(value: Record<string, unknown>): ProjectSort {
    const rawKey = typeof value.sort_key === "string"
        ? value.sort_key
        : typeof value.key === "string"
            ? value.key
            : null;
    const key = rawKey && PROJECT_SUPPORTED_KEYS.includes(rawKey as ProjectSortKey)
        ? (rawKey as ProjectSortKey)
        : "created";
    const direction = value.sort_direction === "asc" || value.direction === "asc" ? "asc" : "desc";

    return { key, direction };
}

export type WorkflowSortKey = "name" | "type" | "created";
export type WorkflowSortDirection = "asc" | "desc";

export interface WorkflowSort {
    key: WorkflowSortKey;
    direction: WorkflowSortDirection;
}

const WORKFLOW_SUPPORTED_KEYS: WorkflowSortKey[] = ["name", "type", "created"];

export function parseWorkflowSort(
  value: Record<string, unknown>,
): WorkflowSort {
    const rawKey = typeof value.sort_key === "string"
        ? value.sort_key
        : typeof value.key === "string"
            ? value.key
            : null;
    const key = rawKey && WORKFLOW_SUPPORTED_KEYS.includes(rawKey as WorkflowSortKey)
        ? (rawKey as WorkflowSortKey)
        : "created";
    const direction = value.sort_direction === "asc" || value.direction === "asc" ? "asc" : "desc";

    return { key, direction };
}
