// Settings shared by the native Google connectors (Drive, Gmail, Calendar).
// Each stores them on its own grant row; the column names and the
// disabled-tool list behave the same way for all three.

export type NativeConnectorSettings = {
    enabled?: boolean;
    requireWriteApproval?: boolean;
    readOnly?: boolean;
};

/** The grant-row columns to update; empty when nothing valid was sent. */
export function connectorSettingsPatch(
    settings: NativeConnectorSettings,
): Record<string, boolean> {
    const patch: Record<string, boolean> = {};
    if (typeof settings.enabled === "boolean") patch.enabled = settings.enabled;
    if (typeof settings.readOnly === "boolean")
        patch.read_only = settings.readOnly;
    if (typeof settings.requireWriteApproval === "boolean")
        patch.require_write_approval = settings.requireWriteApproval;
    return patch;
}

/** The disabled-tool list after switching one tool on or off. */
export function toggleDisabledTool(
    current: readonly string[],
    toolName: string,
    enabled: boolean,
): string[] {
    return enabled
        ? current.filter((name) => name !== toolName)
        : [...new Set([...current, toolName])];
}
