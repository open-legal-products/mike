"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  GoogleWorkspaceProvider,
  GoogleWorkspaceStatus,
  GoogleWorkspaceActionReview,
} from "@mike/contracts";
import {
  getGoogleWorkspaceStatus,
  startGoogleWorkspaceOAuth,
  cancelGoogleWorkspaceOAuth,
  disconnectGoogleWorkspace,
  listGoogleWorkspaceActions,
  decideGoogleWorkspaceAction,
  isMfaRequiredError,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { MfaVerificationPopup } from "@/app/components/popups/MfaVerificationPopup";
import { GoogleWorkspaceActionCard } from "@/app/components/shared/GoogleWorkspaceActionCard";
import { GoogleConnectionCard } from "./GoogleConnectionCard";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";

const names = { gmail: "Gmail", "google-calendar": "Google Calendar" };
class FlowError extends Error {}
type Sensitive = (
  action: () => Promise<void>,
  retry?: () => Promise<void>,
) => Promise<void>;
function ConnectionCard({
  provider,
  sensitive,
  changed,
}: {
  provider: GoogleWorkspaceProvider;
  sensitive: Sensitive;
  changed: () => void;
}) {
  const [status, setStatus] = useState<GoogleWorkspaceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const name = names[provider];
  useEffect(() => {
    let mounted = true;
    getGoogleWorkspaceStatus(provider)
      .then((s) => {
        if (mounted) setStatus(s);
      })
      .catch(() => {
        if (mounted) setError(`Could not load ${name}. Reload this page.`);
      });
    return () => {
      mounted = false;
      abortRef.current?.abort();
    };
  }, [provider, name]);
  const connect = async (write = false) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setAuthorizing(true);
    setBusy(true);
    setError(null);
    const popup = window.open(
      "about:blank",
      `mike_${provider}_oauth`,
      "popup,width=560,height=720",
    );
    let pending: string | null = null;
    try {
      if (!popup)
        throw new FlowError(
          "Allow popups for Mike, then try connecting again.",
        );
      await sensitive(
        async () => {
          const { authorizationUrl } = await startGoogleWorkspaceOAuth(
            provider,
            write,
          );
          pending = new URL(authorizationUrl).searchParams.get("state");
          if (controller.signal.aborted)
            throw new FlowError("Authorization cancelled.");
          popup.location.href = authorizationUrl;
          const started = Date.now();
          while (Date.now() - started < 300_000) {
            if (controller.signal.aborted)
              throw new FlowError("Authorization cancelled.");
            const current = await getGoogleWorkspaceStatus(provider);
            if (
              current.connected &&
              current.grantId !== status?.grantId &&
              current.writeEnabled === write
            ) {
              pending = null;
              setStatus(current);
              changed();
              return;
            }
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, 1500);
              controller.signal.addEventListener("abort", done, { once: true });
              if (controller.signal.aborted) done();
            });
          }
          throw new FlowError("Google authorization timed out. Try again.");
        },
        () => connect(write),
      );
    } catch (e) {
      setError(
        e instanceof FlowError
          ? e.message
          : userFacingApiError(e, `Could not connect ${name}.`),
      );
    } finally {
      if (pending) {
        try {
          await cancelGoogleWorkspaceOAuth(provider, pending);
          setStatus(await getGoogleWorkspaceStatus(provider));
        } catch {
          setError(
            "Could not cancel authorization. Close the Google window and reload this page.",
          );
        }
      }
      try {
        popup?.close();
      } catch {
        /* Google may sever window.opener. */
      }
      setBusy(false);
      setAuthorizing(false);
    }
  };
  const disconnect = async () => {
    try {
      await sensitive(async () => {
        setBusy(true);
        setError(null);
        try {
          await disconnectGoogleWorkspace(provider);
          setStatus(await getGoogleWorkspaceStatus(provider));
          changed();
        } finally {
          setBusy(false);
        }
      });
    } catch (e) {
      setError(userFacingApiError(e, `Could not disconnect ${name}.`));
    }
  };
  return (
    <GoogleConnectionCard
      provider={provider}
      name={name}
      connected={!!status?.connected}
      loading={!status && !error}
      accountEmail={status?.connected ? status.accountEmail : null}
      onConnect={status?.configured && status.schemaReady ? () => void connect(false) : undefined}
      connecting={authorizing}
      error={error}
      summary={
        status
          ? status.connected
            ? status.writeEnabled ? "Writes require approval" : "Read-only"
            : "Not connected"
          : error ? "Unavailable" : "Loading…"
      }
      onClose={() => abortRef.current?.abort()}
    >
      <section className="space-y-3" aria-label={`${name} connection`}>
        <div>
          <h3 className="text-sm font-medium">{name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {provider === "gmail"
              ? "Search and read email."
              : "Search calendars and read events."}
          </p>
        </div>
        {!status ? (
          <p className="text-xs" role="status">
            {error ? "Unavailable" : "Loading…"}
          </p>
        ) : (
          <>
            <p className="break-all text-sm">
              {status.connected
                ? `Connected as ${status.accountEmail ?? "your selected Google account"} · ${status.writeEnabled ? "Writes require approval" : "Read-only"}`
                : "Not connected"}
            </p>
            {!status.schemaReady ? (
              <p className="text-xs text-muted-foreground">
                This server needs the Gmail and Calendar database migration.
              </p>
            ) : !status.configured ? (
              <p className="text-xs text-muted-foreground">
                An administrator must configure a Google OAuth client.
              </p>
            ) : null}
            {status.redirectUri && !status.connected && (
              <details className="text-xs text-muted-foreground">
                <summary
                  tabIndex={0}
                  className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Connection setup
                </summary>
                <p className="mt-2 break-all">
                  Authorized redirect URI: {status.redirectUri}
                </p>
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <PillButtonUI
                tone="blue"
                disabled={busy || !status.configured || !status.schemaReady}
                onClick={() => void connect(false)}
              >
                {status.connected
                  ? "Choose another account / read-only"
                  : "Connect read-only"}
              </PillButtonUI>
              {status.connected && !status.writeEnabled && (
                <PillButtonUI
                  tone="white"
                  disabled={busy}
                  onClick={() => void connect(true)}
                >
                  Enable writes with approval
                </PillButtonUI>
              )}
              {status.connected && (
                <PillButtonUI
                  tone="white"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  Disconnect
                </PillButtonUI>
              )}
              {authorizing && (
                <PillButtonUI
                  tone="white"
                  onClick={() => abortRef.current?.abort()}
                >
                  Cancel authorization
                </PillButtonUI>
              )}
            </div>
            {authorizing && (
              <p role="status" className="text-xs">
                Waiting for Google…
              </p>
            )}
            {status.connected && (
              <p className="text-xs text-muted-foreground">
                Enabling writes opens a new Google consent request. Every action
                still needs your approval in the Assistant conversation.
                Disconnecting removes this service from Mike; manage all app
                permissions in your Google account.
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </GoogleConnectionCard>
  );
}
export function GoogleWorkspacePanel({
  children,
  additionalConnectors,
}: {
  children?: ReactNode;
  additionalConnectors?: ReactNode;
}) {
  const [actions, setActions] = useState<GoogleWorkspaceActionReview[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mfa, setMfa] = useState(false);
  const retryRef = useRef<(() => Promise<void>) | null>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await listGoogleWorkspaceActions();
      setActions(result.actions);
    } catch {
      setError("Could not load Google action proposals.");
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const sensitive: Sensitive = async (action, retry = action) => {
    try {
      await action();
    } catch (e) {
      if (isMfaRequiredError(e)) {
        retryRef.current = retry;
        setMfa(true);
      } else throw e;
    }
  };
  const decide = async (id: string, decision: "approve" | "reject") => {
    setError(null);
    setBusy(id);
    try {
      await sensitive(async () => {
        const result = await decideGoogleWorkspaceAction(id, decision);
        if (result && result.status !== "succeeded") setError(result.message);
        await refresh();
      });
    } catch (e) {
      setError(
        userFacingApiError(
          e,
          "Could not complete this decision. Refresh and check its status before retrying.",
        ),
      );
      await refresh();
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="grid grid-cols-1 gap-3 @min-[32rem]:grid-cols-2">
        {children}
        <ConnectionCard
          provider="gmail"
          sensitive={sensitive}
          changed={() => void refresh()}
        />
        <ConnectionCard
          provider="google-calendar"
          sensitive={sensitive}
          changed={() => void refresh()}
        />
        {additionalConnectors}
      </div>
      <details className="mt-3">
        <summary className="w-fit cursor-pointer rounded text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Recent Google actions
        </summary>
        <section
          id="google-actions"
          aria-label="Google action approvals"
          className="space-y-3 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Recent Google actions</h3>
            <PillButtonUI tone="white" onClick={() => void refresh()}>
              Refresh proposals
            </PillButtonUI>
          </div>
          <p className="text-xs text-muted-foreground">
            Approval is shown in the Assistant conversation where you requested
            the action. This history is available if you need to recover a
            pending proposal. Proposals expire after 10 minutes.
          </p>
          {actions === null ? (
            <p role="status" className="text-sm">
              Loading proposals…
            </p>
          ) : !actions.length ? (
            <p className="text-sm text-muted-foreground">
              No action proposals.
            </p>
          ) : (
            actions.map((action) => (
              <GoogleWorkspaceActionCard
                key={action.id}
                action={action}
                busy={busy !== null}
                onDecision={(decision) => void decide(action.id, decision)}
              />
            ))
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </section>
      </details>
      <MfaVerificationPopup
        open={mfa}
        onCancel={() => {
          setMfa(false);
          retryRef.current = null;
        }}
        onVerified={() => {
          setMfa(false);
          const retry = retryRef.current;
          retryRef.current = null;
          if (retry)
            void sensitive(retry).catch((e) =>
              setError(
                userFacingApiError(
                  e,
                  "Could not complete the verified action.",
                ),
              ),
            );
        }}
      />
    </>
  );
}
