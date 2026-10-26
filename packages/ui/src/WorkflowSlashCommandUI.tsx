export function workflowSlashCommandFromTitle(title: string): string | null {
    const titleSlug = title
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .trim()
        .replace(/[\s-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return titleSlug ? `/${titleSlug}` : null;
}

/**
 * The slash command currently being typed, or null. A command starts at the
 * beginning of the message or after whitespace, and runs to the caret at the
 * end of the draft — so "run /contract-intake" offers the menu just as
 * "/contract-intake" does, while "/contract intake" no longer does.
 */
export function slashCommandQueryFromValue(value: string): string | null {
    const command = /(?:^|\s)(\/\S*)$/.exec(value)?.[1];
    return command ? command.toLowerCase() : null;
}

/**
 * The draft with that command removed, keeping the text around it: picking a
 * workflow mid-sentence must not discard what was already written.
 */
export function withoutSlashCommand(value: string): string {
    return value.replace(/(^|\s)\/\S*$/, "$1");
}

export function WorkflowSlashCommandUI({ title }: { title: string }) {
    const command = workflowSlashCommandFromTitle(title);

    return (
        <p className="mt-2 min-h-5 text-xs leading-5 text-gray-500">
            {command ? (
                <>
                    Type{" "}
                    <span className="text-gray-700">
                        {command}
                    </span>{" "}
                    in chat to activate this workflow.
                </>
            ) : (
                <span aria-hidden="true">&nbsp;</span>
            )}
        </p>
    );
}
