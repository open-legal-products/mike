"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GoogleWorkspaceProvider,
  NativeConnectorTool,
} from "@mike/contracts";
import {
  cancelGoogleDriveOAuth,
  cancelGoogleWorkspaceOAuth,
  disconnectGoogleDrive,
  disconnectGoogleWorkspace,
  getGoogleDriveStatus,
  getGoogleWorkspaceStatus,
  setGoogleDriveToolEnabled,
  setGoogleWorkspaceToolEnabled,
  startGoogleDriveOAuth,
  startGoogleWorkspaceOAuth,
  updateGoogleDriveSettings,
  updateGoogleWorkspaceSettings,
} from "@/app/lib/mikeApi";

export type GoogleConnectorProvider = "google-drive" | GoogleWorkspaceProvider;

export const GOOGLE_CONNECTORS: {
  provider: GoogleConnectorProvider;
  name: string;
}[] = [
  { provider: "google-drive", name: "Google Drive" },
  { provider: "gmail", name: "Gmail" },
  { provider: "google-calendar", name: "Google Calendar" },
];

/** What the Settings page needs from Drive's and Workspace's status shapes. */
export type GoogleConnectorStatus = {
  connected: boolean;
  configured: boolean;
  schemaReady?: boolean;
  enabled: boolean;
  requireWriteApproval?: boolean;
  readOnly?: boolean;
  /** False when Google withheld write access. */
  writeEnabled?: boolean;
  accountEmail?: string;
  grantId?: string;
  tools: NativeConnectorTool[];
};

/** Thrown when the user cancels authorization; not a failure to report. */
export class GoogleAuthorizationCancelledError extends Error {
  constructor() {
    super("Authorization cancelled.");
    this.name = "GoogleAuthorizationCancelledError";
  }
}

/** A failure whose message is safe and useful to show as written. */
export class GoogleConnectorFlowError extends Error {}

function connectorApi(provider: GoogleConnectorProvider) {
  if (provider === "google-drive")
    return {
      status: getGoogleDriveStatus,
      start: startGoogleDriveOAuth,
      cancel: cancelGoogleDriveOAuth,
      disconnect: disconnectGoogleDrive,
      updateSettings: updateGoogleDriveSettings,
      setToolEnabled: setGoogleDriveToolEnabled,
    };
  return {
    status: () => getGoogleWorkspaceStatus(provider),
    start: () => startGoogleWorkspaceOAuth(provider),
    cancel: (state: string) => cancelGoogleWorkspaceOAuth(provider, state),
    disconnect: () => disconnectGoogleWorkspace(provider),
    updateSettings: (settings: {
      enabled?: boolean;
      requireWriteApproval?: boolean;
      readOnly?: boolean;
    }) => updateGoogleWorkspaceSettings(provider, settings),
    setToolEnabled: (name: string, enabled: boolean) =>
      setGoogleWorkspaceToolEnabled(provider, name, enabled),
  };
}

const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;

export type GoogleConnector = ReturnType<typeof useGoogleConnector>;

/**
 * One Google connector's state and actions. Every action throws on failure
 * so the page can route errors (and MFA challenges) the same way it does for
 * MCP connectors; only a user cancel throws GoogleAuthorizationCancelledError.
 */
export function useGoogleConnector(
  provider: GoogleConnectorProvider,
  name: string,
) {
  const [status, setStatus] = useState<GoogleConnectorStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // "adding" covers the start request; "authorizing" the Google window.
  const [phase, setPhase] = useState<"idle" | "adding" | "authorizing">("idle");
  const abortRef = useRef<AbortController | null>(null);
  const statusRef = useRef<GoogleConnectorStatus | null>(null);
  statusRef.current = status;
  const api = connectorApi(provider);

  const refresh = useCallback(async () => {
    const next = await connectorApi(provider).status();
    setStatus(next);
    setLoadFailed(false);
    return next;
  }, [provider]);

  useEffect(() => {
    let mounted = true;
    connectorApi(provider)
      .status()
      .then((next) => {
        if (mounted) setStatus(next);
      })
      .catch(() => {
        if (mounted) setLoadFailed(true);
      });
    return () => {
      mounted = false;
      abortRef.current?.abort();
    };
  }, [provider]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Opens Google's consent window and waits for the backend to record a new
   * grant.
   */
  const connect = async () => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const previousGrant = statusRef.current?.connected
      ? (statusRef.current.grantId ?? "connected")
      : null;
    // Open synchronously so the browser treats it as user-initiated.
    const popup = window.open(
      "about:blank",
      `mike_${provider}_oauth`,
      "popup,width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
    );
    let pending: string | null = null;
    setPhase("adding");
    try {
      if (!popup)
        throw new GoogleConnectorFlowError(
          "Allow popups for Mike, then try adding the connector again.",
        );
      const { authorizationUrl } = await api.start();
      pending = new URL(authorizationUrl).searchParams.get("state");
      if (controller.signal.aborted)
        throw new GoogleAuthorizationCancelledError();
      popup.location.href = authorizationUrl;
      setPhase("authorizing");
      const started = Date.now();
      while (Date.now() - started < AUTHORIZATION_TIMEOUT_MS) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(
            done,
            Date.now() - started < 60_000 ? 1500 : 5000,
          );
          controller.signal.addEventListener("abort", done, { once: true });
        });
        if (controller.signal.aborted)
          throw new GoogleAuthorizationCancelledError();
        const next: GoogleConnectorStatus | null = await api
          .status()
          .catch(() => null);
        if (
          next?.connected &&
          (next.grantId ?? "connected") !== previousGrant
        ) {
          pending = null;
          setStatus(next);
          return next;
        }
      }
      throw new GoogleConnectorFlowError(
        "Google authorization timed out. Try again.",
      );
    } finally {
      if (pending) {
        const state = pending;
        await api.cancel(state).catch(() => undefined);
        await refresh().catch(() => undefined);
      }
      try {
        popup?.close();
      } catch {
        // Google may sever window.opener; the popup then closes itself.
      }
      if (abortRef.current === controller) abortRef.current = null;
      setPhase("idle");
    }
  };

  const disconnect = async () => {
    await api.disconnect();
    await refresh();
  };

  const updateSettings = async (settings: {
    enabled?: boolean;
    requireWriteApproval?: boolean;
    readOnly?: boolean;
  }) => {
    setStatus(await api.updateSettings(settings));
  };

  const setToolEnabled = async (toolName: string, enabled: boolean) => {
    setStatus(await api.setToolEnabled(toolName, enabled));
  };

  return {
    provider,
    name,
    status,
    loading: !status && !loadFailed,
    loadFailed,
    phase,
    connect,
    cancel,
    refresh,
    disconnect,
    updateSettings,
    setToolEnabled,
  };
}
