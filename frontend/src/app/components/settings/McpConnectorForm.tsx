"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import {
  FieldLabel,
  FORM_CONTROL_GLASS_CLASS,
  FormTextInput,
} from "@/app/components/ui/form-field";
import { settingsGlassIconButtonClassName } from "@/app/(pages)/settings/settingsStyles";

export type McpConnectorFormDraft = {
  name: string;
  serverUrl: string;
  bearerToken: string;
  customHeaders: string;
};

type TokenAction = {
  label: string;
  loading?: boolean;
  cleared?: boolean;
  onClick: () => void;
};

export function McpConnectorForm({
  idPrefix,
  draft,
  showToken,
  tokenPlaceholder,
  tokenAction,
  disabled = false,
  className = "",
  onDraftChange,
  onShowTokenChange,
}: {
  idPrefix: string;
  draft: McpConnectorFormDraft;
  showToken: boolean;
  tokenPlaceholder: string;
  tokenAction?: TokenAction;
  disabled?: boolean;
  className?: string;
  onDraftChange: (draft: McpConnectorFormDraft) => void;
  onShowTokenChange: (show: boolean) => void;
}) {
  const labelId = `${idPrefix}-label`;
  const urlId = `${idPrefix}-url`;
  const tokenId = `${idPrefix}-token`;
  const headersId = `${idPrefix}-headers`;

  return (
    <div className={`grid gap-3 ${className}`}>
      <div className="min-w-0">
        <FieldLabel htmlFor={labelId}>Label</FieldLabel>
        <FormTextInput
          id={labelId}
          value={draft.name}
          onChange={(event) =>
            onDraftChange({ ...draft, name: event.target.value })
          }
          placeholder="Connector label"
          disabled={disabled}
        />
      </div>
      <div className="min-w-0">
        <FieldLabel htmlFor={urlId}>URL endpoint</FieldLabel>
        <FormTextInput
          id={urlId}
          value={draft.serverUrl}
          onChange={(event) =>
            onDraftChange({ ...draft, serverUrl: event.target.value })
          }
          placeholder="https://mcp.example.com/mcp"
          disabled={disabled}
        />
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor={tokenId}>Bearer token</FieldLabel>
          <p className="mb-2 shrink-0 text-xs text-gray-500">
            Tokens are stored encrypted.
          </p>
        </div>
        <div className="relative">
          <FormTextInput
            id={tokenId}
            value={draft.bearerToken}
            onChange={(event) =>
              onDraftChange({ ...draft, bearerToken: event.target.value })
            }
            type={showToken ? "text" : "password"}
            placeholder={tokenPlaceholder}
            className={
              tokenAction
                ? draft.bearerToken
                  ? "pr-[6.5rem]"
                  : "pr-16"
                : "pr-10"
            }
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
          {draft.bearerToken && (
            <button
              type="button"
              className={`absolute inset-y-1 ${
                tokenAction ? "right-[3.75rem]" : "right-1.5"
              } flex items-center ${settingsGlassIconButtonClassName}`}
              onClick={() => onShowTokenChange(!showToken)}
              aria-label={showToken ? "Hide token" : "Show token"}
              disabled={disabled}
            >
              {showToken ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          )}
          {tokenAction && (
            <button
              type="button"
              onClick={tokenAction.onClick}
              disabled={disabled || tokenAction.loading || tokenAction.cleared}
              className={`absolute inset-y-1 right-1.5 px-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:text-gray-300 ${
                tokenAction.cleared
                  ? "text-red-600 hover:text-red-700"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              <span className="inline-flex items-center gap-1">
                {tokenAction.label}
                {tokenAction.loading && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
              </span>
            </button>
          )}
        </div>
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor={headersId}>Custom headers</FieldLabel>
          <p className="mb-2 shrink-0 text-xs text-gray-500">
            Secrets are stored encrypted.
          </p>
        </div>
        <textarea
          id={headersId}
          value={draft.customHeaders}
          onChange={(event) =>
            onDraftChange({ ...draft, customHeaders: event.target.value })
          }
          placeholder='{"X-API-Key":"secret"}'
          className={`min-h-32 resize-y py-2 ${FORM_CONTROL_GLASS_CLASS}`}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
