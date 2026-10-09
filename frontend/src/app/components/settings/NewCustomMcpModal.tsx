"use client";

import { Check, Loader2 } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import {
    McpConnectorForm,
    type McpConnectorFormDraft,
} from "@/app/components/settings/McpConnectorForm";
import type { McpConnectorSummary } from "@/app/lib/mikeApi";

export type NewCustomMcpDraft = McpConnectorFormDraft;

export type NewCustomMcpStep = "form" | "working" | "auth" | "success";

interface NewCustomMcpModalProps {
    open: boolean;
    draft: NewCustomMcpDraft;
    step: NewCustomMcpStep;
    result: McpConnectorSummary | null;
    authMessage: string | null;
    showToken: boolean;
    onDraftChange: (draft: NewCustomMcpDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onClose: () => void;
    onSubmit: () => Promise<void>;
    onOpenConnector: (connectorId: string) => void;
}

export function NewCustomMcpModal({
    open,
    draft,
    step,
    result,
    authMessage,
    showToken,
    onDraftChange,
    onShowTokenChange,
    onClose,
    onSubmit,
    onOpenConnector,
}: NewCustomMcpModalProps) {
    const canSubmit =
        draft.name.trim().length > 0 &&
        draft.serverUrl.trim().length > 0 &&
        step !== "working" &&
        step !== "auth";

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Connectors", "New Custom Connector"]}
            size="lg"
            primaryAction={
                step === "success" && result
                    ? {
                          label: "View connector",
                          onClick: () => onOpenConnector(result.id),
                      }
                    : {
                          label:
                              step === "working"
                                  ? "Connecting..."
                                  : step === "auth"
                                    ? "Authorizing..."
                                    : "Connect",
                          icon:
                              step === "working" || step === "auth" ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                              ) : undefined,
                          onClick: () => void onSubmit(),
                          disabled: !canSubmit,
                      }
            }
            cancelAction={
                // "working" is a brief synchronous create with nothing to
                // interrupt, so it stays uncancellable. "auth" now offers a
                // Cancel button: COOP can sever the popup so the flow may never
                // report a result on its own, and the user needs a reliable
                // escape hatch instead of waiting out the five-minute timeout.
                step === "working"
                    ? false
                    : {
                          label: step === "success" ? "Done" : "Cancel",
                          onClick: onClose,
                      }
            }
        >
            {step === "success" && result ? (
                <NewCustomMcpSuccess connector={result} />
            ) : step === "auth" ? (
                <NewCustomMcpAuth
                    message={
                        authMessage ??
                        "Complete authorization in the popup to finish connecting this MCP server."
                    }
                />
            ) : (
                <div className="min-h-0 flex-1 space-y-4 pb-4">
                    <McpConnectorForm
                        idPrefix="new-mcp"
                        draft={draft}
                        showToken={showToken}
                        tokenPlaceholder="Bearer token"
                        disabled={step === "working"}
                        className="pt-1"
                        onDraftChange={onDraftChange}
                        onShowTokenChange={onShowTokenChange}
                    />
                </div>
            )}
        </Modal>
    );
}

function NewCustomMcpSuccess({
    connector,
}: {
    connector: McpConnectorSummary;
}) {
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col gap-4 pb-4">
            <div className="flex items-start gap-3 rounded-xl border border-green-100/80 bg-green-50/80 px-3 py-3 text-green-800 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)]">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <p className="min-w-0 truncate text-sm font-medium">
                    {connector.name} is connected.{" "}
                    <span className="font-normal text-green-700">
                        {connector.tools.length} tools discovered.
                    </span>
                </p>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-gray-100 bg-white/60">
                <div className="max-h-full overflow-y-auto divide-y divide-gray-100">
                    {connector.tools.map((tool) => (
                        <div
                            key={tool.openaiToolName}
                            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-gray-700">
                                    {tool.title ?? tool.openaiToolName}
                                </p>
                                {tool.description && (
                                    <p className="truncate text-xs text-gray-500">
                                        {tool.description}
                                    </p>
                                )}
                            </div>
                            <span className="text-xs text-gray-400">
                                {tool.enabled ? "Enabled" : "Disabled"}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function NewCustomMcpAuth({ message }: { message: string }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pb-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/70 bg-white/75 text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)]">
                <Loader2 className="h-4 w-4 animate-spin" />
            </div>
            <div className="max-w-sm space-y-1">
                <h3 className="text-sm font-medium text-gray-700">
                    Authentication required
                </h3>
                <p className="text-sm text-gray-500">{message}</p>
            </div>
        </div>
    );
}
