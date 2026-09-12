"use client";

import { Check, ChevronDown, Eye, EyeOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    SETTINGS_CONTROL_CLASS,
    SettingsTextInput,
} from "@/app/components/settings/SettingsTextInput";
import { Modal } from "@/app/components/modals/Modal";
import type { McpConnectorSummary } from "@/app/lib/mikeApi";
import {
    settingsGlassIconButtonClassName,
} from "@/app/(pages)/settings/settingsStyles";

export type NewMcpDraft = {
    name: string;
    serverUrl: string;
    bearerToken: string;
    customHeaders: string;
};

export type NewMcpStep = "form" | "working" | "auth" | "success";

interface NewMcpModalProps {
    open: boolean;
    draft: NewMcpDraft;
    step: NewMcpStep;
    result: McpConnectorSummary | null;
    error: string | null;
    authMessage: string | null;
    showToken: boolean;
    showAdvanced: boolean;
    onDraftChange: (draft: NewMcpDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
    onClose: () => void;
    onSubmit: () => Promise<void>;
    onOpenConnector: (connectorId: string) => void;
}

export function NewMcpModal({
    open,
    draft,
    step,
    result,
    error,
    authMessage,
    showToken,
    showAdvanced,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
    onClose,
    onSubmit,
    onOpenConnector,
}: NewMcpModalProps) {
    const t = useTranslations("configuracoes.mcp");
    const tComum = useTranslations("common");
    const canSubmit =
        draft.name.trim().length > 0 &&
        draft.serverUrl.trim().length > 0 &&
        step !== "working" &&
        step !== "auth";

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[
                t("trilhaConectores"),
                step === "success"
                    ? t("trilhaAdicionado")
                    : step === "auth"
                      ? t("trilhaAutenticar")
                      : t("trilhaNovo"),
            ]}
            size="lg"
            primaryAction={
                step === "success" && result
                    ? {
                          label: t("verConector"),
                          onClick: () => onOpenConnector(result.id),
                      }
                    : {
                          label:
                              step === "working"
                                  ? t("conectando")
                                  : step === "auth"
                                    ? t("autorizando")
                                    : t("conectar"),
                          icon:
                              step === "working" || step === "auth" ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                              ) : undefined,
                          onClick: () => void onSubmit(),
                          disabled: !canSubmit,
                      }
            }
            cancelAction={
                step === "working" || step === "auth"
                    ? false
                    : {
                          label:
                              step === "success"
                                  ? t("concluido")
                                  : tComum("cancel"),
                          onClick: onClose,
                      }
            }
            footerStatus={
                error ? (
                    <div className="rounded-xl border border-white/70 bg-white/75 px-3 py-2 text-sm text-red-600 shadow-[0_12px_32px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-xl">
                        {error}
                    </div>
                ) : null
            }
        >
            {step === "success" && result ? (
                <NewMcpSuccess connector={result} />
            ) : step === "auth" ? (
                <NewMcpAuth
                    message={
                        authMessage ?? t("corpoAutenticacaoPadrao")
                    }
                />
            ) : (
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
                    <p className="text-sm text-gray-500">
                        {t("descricaoForm")}
                    </p>
                    <NewMcpForm
                        draft={draft}
                        showToken={showToken}
                        showAdvanced={showAdvanced}
                        disabled={step === "working"}
                        onDraftChange={onDraftChange}
                        onShowTokenChange={onShowTokenChange}
                        onShowAdvancedChange={onShowAdvancedChange}
                    />
                </div>
            )}
        </Modal>
    );
}

function NewMcpForm({
    draft,
    showToken,
    showAdvanced,
    disabled,
    onDraftChange,
    onShowTokenChange,
    onShowAdvancedChange,
}: {
    draft: NewMcpDraft;
    showToken: boolean;
    showAdvanced: boolean;
    disabled: boolean;
    onDraftChange: (draft: NewMcpDraft) => void;
    onShowTokenChange: (show: boolean) => void;
    onShowAdvancedChange: (show: boolean) => void;
}) {
    const t = useTranslations("configuracoes.mcp");
    return (
        <div className="grid gap-3 pt-1">
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
                <FieldLabel htmlFor="new-mcp-label">{t("labelNome")}</FieldLabel>
                <SettingsTextInput
                    id="new-mcp-label"
                    value={draft.name}
                    onChange={(event) =>
                        onDraftChange({ ...draft, name: event.target.value })
                    }
                    placeholder={t("placeholderNome")}
                    className="h-8"
                    disabled={disabled}
                />
            </div>
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-center">
                <FieldLabel htmlFor="new-mcp-url">{t("labelUrl")}</FieldLabel>
                <SettingsTextInput
                    id="new-mcp-url"
                    value={draft.serverUrl}
                    onChange={(event) =>
                        onDraftChange({
                            ...draft,
                            serverUrl: event.target.value,
                        })
                    }
                    placeholder="https://mcp.example.com/mcp"
                    className="h-8"
                    disabled={disabled}
                />
            </div>
            <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
                <FieldLabel htmlFor="new-mcp-token">
                    {t("labelToken")}
                </FieldLabel>
                <div className="min-w-0">
                    <div className="relative">
                        <SettingsTextInput
                            id="new-mcp-token"
                            value={draft.bearerToken}
                            onChange={(event) =>
                                onDraftChange({
                                    ...draft,
                                    bearerToken: event.target.value,
                                })
                            }
                            type={showToken ? "text" : "password"}
                            placeholder={t("placeholderToken")}
                            className="h-8 pr-10"
                            autoComplete="off"
                            spellCheck={false}
                            disabled={disabled}
                        />
                        {draft.bearerToken && (
                            <button
                                type="button"
                                className={`absolute inset-y-1 right-1.5 flex items-center ${settingsGlassIconButtonClassName}`}
                                onClick={() => onShowTokenChange(!showToken)}
                                aria-label={
                                    showToken
                                        ? t("ocultarToken")
                                        : t("mostrarToken")
                                }
                                disabled={disabled}
                            >
                                {showToken ? (
                                    <EyeOff className="h-4 w-4" />
                                ) : (
                                    <Eye className="h-4 w-4" />
                                )}
                            </button>
                        )}
                    </div>
                    <p className="mt-1 text-right text-xs text-gray-500">
                        {t("notaTokens")}
                    </p>
                </div>
            </div>
            <div className="grid gap-2">
                <button
                    type="button"
                    onClick={() => onShowAdvancedChange(!showAdvanced)}
                    className="inline-flex items-center gap-1 justify-self-start text-xs font-medium text-gray-500 transition-colors hover:text-gray-900"
                    disabled={disabled}
                >
                    {t("avancado")}
                    <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${
                            showAdvanced ? "" : "-rotate-90"
                        }`}
                    />
                </button>
                {showAdvanced && (
                    <div className="grid gap-2 sm:grid-cols-[96px_minmax(0,1fr)] sm:items-start">
                        <FieldLabel htmlFor="new-mcp-headers">
                            {t("labelHeaders")}
                        </FieldLabel>
                        <div className="min-w-0">
                            <textarea
                                id="new-mcp-headers"
                                value={draft.customHeaders}
                                onChange={(event) =>
                                    onDraftChange({
                                        ...draft,
                                        customHeaders: event.target.value,
                                    })
                                }
                                placeholder='{"X-API-Key":"secret"}'
                                className={`min-h-20 resize-y py-2 ${SETTINGS_CONTROL_CLASS}`}
                                autoComplete="off"
                                spellCheck={false}
                                disabled={disabled}
                            />
                            <p className="mt-1 text-right text-xs text-gray-500">
                                {t("notaSecrets")}
                            </p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function NewMcpSuccess({ connector }: { connector: McpConnectorSummary }) {
    const t = useTranslations("configuracoes.mcp");
    return (
        <div className="flex h-full min-h-0 flex-1 flex-col gap-4 pb-4">
            <div className="flex items-start gap-3 rounded-xl border border-green-100/80 bg-green-50/80 px-3 py-3 text-green-800 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-xl">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                <p className="min-w-0 truncate text-sm font-medium">
                    {t("conectado", { nome: connector.name })}{" "}
                    <span className="font-normal text-green-700">
                        {t("ferramentasDescobertas", {
                            count: connector.tools.length,
                        })}
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
                                {tool.enabled
                                    ? t("ferramentaAtivada")
                                    : t("ferramentaDesativada")}
                            </span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function NewMcpAuth({ message }: { message: string }) {
    const t = useTranslations("configuracoes.mcp");
    return (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 pb-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/70 bg-white/75 text-gray-700 shadow-[0_3px_9px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-4px_9px_rgba(255,255,255,0.05)] backdrop-blur-xl">
                <Loader2 className="h-4 w-4 animate-spin" />
            </div>
            <div className="max-w-sm space-y-1">
                <h3 className="text-sm font-medium text-gray-700">
                    {t("autenticacaoRequerida")}
                </h3>
                <p className="text-sm text-gray-500">{message}</p>
            </div>
        </div>
    );
}
