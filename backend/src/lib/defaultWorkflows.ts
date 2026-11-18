// The workflows every user gets by default, and which of them appear as quick
// actions. A deployment sets the list with MIKE_DEFAULT_WORKFLOWS_JSON, a JSON
// array of {"key", "quickAction"?, "wordQuickAction"?}; unset or blank keeps
// Mike's own five. The catalog sync refuses a workflow archive that lacks any
// listed key, so the list and the catalog repository must agree.

export type DefaultWorkflow = {
    key: string;
    quickAction: boolean;
    wordQuickAction: boolean;
};

const ENV = "MIKE_DEFAULT_WORKFLOWS_JSON";
const WORKFLOW_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIKE_DEFAULT_WORKFLOWS: readonly DefaultWorkflow[] = [
    { key: "proofread", quickAction: true, wordQuickAction: true },
    { key: "compare-documents", quickAction: true, wordQuickAction: false },
    { key: "extract-key-terms", quickAction: true, wordQuickAction: true },
    { key: "draft-from-template", quickAction: true, wordQuickAction: true },
    {
        key: "commercial-agreement-tabular-review",
        quickAction: false,
        wordQuickAction: false,
    },
];

let cached: DefaultWorkflow[] | undefined;
let cachedByKey:
    | Map<string, DefaultWorkflow & { sortOrder: number }>
    | undefined;

function optionalFlag(value: unknown, label: string): boolean {
    if (value === undefined) return false;
    if (typeof value !== "boolean") {
        throw new Error(`${ENV}: ${label} must be true or false`);
    }
    return value;
}

function parseDefaultWorkflows(raw: string): DefaultWorkflow[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `${ENV} is not valid JSON: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (!Array.isArray(parsed)) {
        throw new Error(`${ENV} must be a JSON array`);
    }
    const seen = new Set<string>();
    return parsed.map((entry, index) => {
        const label = `entry ${index}`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`${ENV}: ${label} must be an object`);
        }
        const record = entry as Record<string, unknown>;
        const key = record.key;
        if (typeof key !== "string" || !WORKFLOW_KEY_PATTERN.test(key)) {
            throw new Error(
                `${ENV}: ${label} needs a "key" of lower-case words joined by hyphens`,
            );
        }
        if (seen.has(key)) {
            throw new Error(`${ENV}: duplicate key '${key}'`);
        }
        seen.add(key);
        return {
            key,
            quickAction: optionalFlag(record.quickAction, `${label}.quickAction`),
            wordQuickAction: optionalFlag(
                record.wordQuickAction,
                `${label}.wordQuickAction`,
            ),
        };
    });
}

/** The default workflows in display order. Parsed once; a bad value throws. */
export function loadDefaultWorkflows(): DefaultWorkflow[] {
    if (cached) return cached;
    const raw = process.env[ENV]?.trim();
    cached = raw
        ? parseDefaultWorkflows(raw)
        : MIKE_DEFAULT_WORKFLOWS.map((workflow) => ({ ...workflow }));
    return cached;
}

/** The default workflows by key, each with its position in the list. */
export function defaultWorkflowByKey(): Map<
    string,
    DefaultWorkflow & { sortOrder: number }
> {
    if (cachedByKey) return cachedByKey;
    cachedByKey = new Map(
        loadDefaultWorkflows().map((workflow, sortOrder) => [
            workflow.key,
            { ...workflow, sortOrder },
        ]),
    );
    return cachedByKey;
}

/** Forget the parsed list, so tests can change the environment. */
export function resetDefaultWorkflowsCache(): void {
    cached = undefined;
    cachedByKey = undefined;
}
