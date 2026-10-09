"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { FieldLabel } from "@/app/components/ui/form-field";
import { Modal } from "@/app/components/modals/Modal";
import { LIQUID_GLASS_FLAT_CLASS } from "@/shared/ui/LiquidGlassUI";
import { TabPillButtonUI } from "@/shared/ui/TabPillButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";

export type ConnectorToolView = {
    id: string;
    title: string;
    description: string | null;
    enabled: boolean;
    /** Changes data; held for approval when the connector asks for permission. */
    write: boolean;
};

export type ConnectorDetailsView = {
    id: string;
    name: string;
    tools: ConnectorToolView[];
    toolCount: number;
    readOnly: boolean;
    /**
     * Whether write actions wait for approval. Undefined for a connector with
     * no write-approval setting, which then shows no setting.
     */
    requireWriteApproval?: boolean;
    /** The account the connection signed in as, when the connector reports one. */
    accountEmail?: string;
};

/**
 * The Manage dialog every connector shares — Slack, Notion, custom MCP
 * servers and Google alike: write-approval setting, tool switches, Refresh
 * and Delete. A custom MCP server adds a Details tab through `details`.
 */
export function ConnectorDetailsModal({
    connector,
    busyKey,
    toolsLoading,
    details,
    reconnecting = false,
    onClose,
    onRefresh,
    onCancelReconnect,
    onDelete,
    onToolEnabled,
    onReadOnly,
    onRequireWriteApproval,
}: {
    connector: ConnectorDetailsView | null;
    busyKey: string | null;
    toolsLoading: boolean;
    details?: ReactNode;
    reconnecting?: boolean;
    onClose: () => void;
    onRefresh: () => void;
    onCancelReconnect?: () => void;
    onDelete: () => void;
    onToolEnabled: (toolId: string, enabled: boolean) => void;
    onReadOnly: (enabled: boolean) => void;
    onRequireWriteApproval?: (enabled: boolean) => void;
}) {
    // The picked section is stored against the connector it was picked for, so
    // opening a different connector falls back to "details" without an effect
    // resetting state after the first render.
    const [picked, setPicked] = useState<{
        connectorId: string | null;
        section: "details" | "tools";
    }>({ connectorId: null, section: "details" });
    const section =
        picked.connectorId === (connector?.id ?? null)
            ? picked.section
            : "details";
    const setSection = (next: "details" | "tools") =>
        setPicked({ connectorId: connector?.id ?? null, section: next });
    const showDetails = !!details && section === "details";
    const contentPadding = details
        ? showDetails ? "pb-4" : "pb-2"
        : "px-2 pt-2 pb-4";
    const toolCount = connector
        ? toolsLoading
            ? connector.toolCount
            : connector.tools.length
        : 0;
    const hasWriteTools = !!connector?.tools.some((tool) => tool.write);

    return (
        <Modal
            open={!!connector}
            onClose={onClose}
            breadcrumbs={["Connectors", connector?.name ?? "Connector"]}
            size="lg"
            secondaryAction={
                connector
                    ? {
                          label: "Delete",
                          variant: "danger",
                          onClick: onDelete,
                          disabled: busyKey !== null,
                      }
                    : undefined
            }
        >
            {connector && (
                <div
                    className={`flex min-h-0 flex-1 flex-col gap-5 ${contentPadding}`}
                >
                    {details && (
                        <div className="flex items-center gap-1.5">
                            {(["details", "tools"] as const).map((tab) => (
                                <TabPillButtonUI
                                    key={tab}
                                    active={section === tab}
                                    onClick={() => setSection(tab)}
                                >
                                    {tab === "details" ? "Details" : "Tools"}
                                </TabPillButtonUI>
                            ))}
                        </div>
                    )}
                    {showDetails ? (
                        details
                    ) : (
                        <div className="flex min-h-0 flex-1 flex-col gap-4">
                            {connector.accountEmail && (
                                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                                    <p className="text-sm font-medium text-gray-700">
                                        Account
                                    </p>
                                    <p className="min-w-0 text-sm text-gray-500 [overflow-wrap:anywhere]">
                                        {connector.accountEmail}
                                    </p>
                                </div>
                            )}
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p id={`read-only-${connector.id}`} className="text-sm font-medium text-gray-700">
                                        Read-only
                                    </p>
                                    <p id={`read-only-description-${connector.id}`} className="mt-0.5 text-xs text-gray-500">
                                        Disable all write tools. Turn off to restore your individual tool settings.
                                    </p>
                                </div>
                                <ToggleSwitchUI
                                    className="shrink-0"
                                    checked={connector.readOnly}
                                    disabled={busyKey !== null || toolsLoading}
                                    aria-busy={busyKey === `read-only:${connector.id}`}
                                    aria-labelledby={`read-only-${connector.id}`}
                                    aria-describedby={`read-only-description-${connector.id}`}
                                    onCheckedChange={onReadOnly}
                                />
                            </div>
                            {!connector.readOnly &&
                                connector.requireWriteApproval !== undefined &&
                                onRequireWriteApproval && (
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p
                                                id={`write-approval-${connector.id}`}
                                                className="text-sm font-medium text-gray-700"
                                            >
                                                Ask for permission for write
                                                actions
                                            </p>
                                            <p className="mt-0.5 text-xs text-gray-500">
                                                {hasWriteTools || toolsLoading
                                                    ? "Mike asks you in the chat before running an action that changes data."
                                                    : "This connector has no write actions right now."}
                                            </p>
                                        </div>
                                        <ToggleSwitchUI
                                            className="shrink-0"
                                            checked={
                                                connector.requireWriteApproval
                                            }
                                            disabled={busyKey !== null}
                                            aria-busy={
                                                busyKey ===
                                                `approval:${connector.id}`
                                            }
                                            aria-labelledby={`write-approval-${connector.id}`}
                                            onCheckedChange={
                                                onRequireWriteApproval
                                            }
                                        />
                                    </div>
                                )}
                            <div className="flex min-h-0 flex-1 flex-col">
                                <div className="flex items-baseline justify-between gap-2">
                                    <FieldLabel as="p">
                                        {toolCount}{" "}
                                        {toolCount === 1 ? "Tool" : "Tools"}
                                    </FieldLabel>
                                    <div className="mb-2 flex items-center gap-3">
                                        {reconnecting && onCancelReconnect && (
                                            <button
                                                type="button"
                                                onClick={onCancelReconnect}
                                                className="rounded text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                            >
                                                Cancel
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={onRefresh}
                                            disabled={busyKey !== null}
                                            className="inline-flex items-center gap-1 rounded text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:text-gray-300"
                                        >
                                            {busyKey ===
                                            `refresh:${connector.id}` ? (
                                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            ) : (
                                                <RefreshCw className="h-3.5 w-3.5" />
                                            )}
                                            Refresh
                                        </button>
                                    </div>
                                </div>
                                {toolsLoading ? (
                                    <ToolListSkeleton
                                        count={connector.toolCount}
                                    />
                                ) : (
                                    <ToolList
                                        tools={connector.tools}
                                        readOnly={connector.readOnly}
                                        busyKey={busyKey}
                                        onToolEnabled={onToolEnabled}
                                    />
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </Modal>
    );
}

function ToolListSkeleton({ count }: { count: number }) {
    const rowCount = Math.min(Math.max(count || 3, 3), 8);
    return (
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-100 bg-white/60">
            <div>
                {Array.from({ length: rowCount }).map((_, index) => (
                    <div key={index} className="px-3 py-3">
                        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                            <div className="h-5 w-5" />
                            <div className="h-3.5 w-full max-w-[220px] animate-pulse rounded bg-gray-100" />
                            <div className="h-4 w-7 animate-pulse rounded-full bg-gray-100" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function ToolList({
    tools,
    readOnly,
    busyKey,
    onToolEnabled,
}: {
    tools: ConnectorToolView[];
    readOnly: boolean;
    busyKey: string | null;
    onToolEnabled: (toolId: string, enabled: boolean) => void;
}) {
    const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

    if (tools.length === 0) {
        return (
            <div
                className={`min-h-0 flex-1 rounded-lg px-3 py-3 text-sm text-gray-500 ${LIQUID_GLASS_FLAT_CLASS}`}
            >
                No tools discovered yet.
            </div>
        );
    }

    return (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-gray-100 bg-white/60">
            <div>
                {tools.map((tool) => {
                    const busy = busyKey === `tool:${tool.id}`;
                    const isExpanded = expandedToolId === tool.id;
                    return (
                        <div key={tool.id} className="px-3 py-3">
                            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                                <button
                                    type="button"
                                    onClick={() =>
                                        setExpandedToolId(
                                            isExpanded ? null : tool.id,
                                        )
                                    }
                                    className="inline-flex h-5 w-5 items-center justify-center rounded text-gray-400 transition-colors hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                    aria-expanded={isExpanded}
                                    aria-label={`${isExpanded ? "Collapse" : "Expand"} ${tool.title}`}
                                >
                                    <ChevronDown
                                        className={`h-3.5 w-3.5 transition-transform ${
                                            isExpanded ? "" : "-rotate-90"
                                        }`}
                                    />
                                </button>
                                <p className="min-w-0 text-sm font-medium text-gray-700 [overflow-wrap:anywhere]">
                                    {tool.title}
                                    {tool.write && (
                                        <span className="ml-2 text-xs font-normal text-gray-500">
                                            Write
                                        </span>
                                    )}
                                </p>
                                <ToggleSwitchUI
                                    checked={tool.enabled && !(readOnly && tool.write)}
                                    disabled={busyKey !== null || (readOnly && tool.write)}
                                    aria-busy={busy}
                                    aria-label={`${tool.title} enabled`}
                                    onCheckedChange={(enabled) =>
                                        onToolEnabled(tool.id, enabled)
                                    }
                                />
                            </div>
                            {isExpanded && tool.description && (
                                <p className="ml-7 mt-2 min-w-0 text-xs text-gray-500 [overflow-wrap:anywhere]">
                                    {tool.description}
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
