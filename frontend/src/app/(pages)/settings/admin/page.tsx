"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AdminFeatureFlagsResponse,
  AdminUserFeatureFlags,
  FeatureFlagKey,
  FeatureFlagSummary,
} from "@mike/contracts";
import {
  getAdminFeatureFlags,
  getAdminUserFeatureFlags,
  setAdminFeatureFlagDefault,
  setAdminUserFeatureFlag,
} from "@/app/lib/mikeApi";
import { describeError, notifyError } from "@/app/lib/userFacingError";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { TextButtonUI } from "@/shared/ui/TextButtonUI";
import { ToggleSwitchUI } from "@/shared/ui/ToggleSwitchUI";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsSelectRow,
  type SettingsSelectOption,
} from "@/app/components/settings/SettingsSelectRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";

/**
 * Settings → Admin: the instance admin panel. Listed only for accounts the
 * server names in MIKE_ADMIN_EMAILS; everyone else who opens the URL is told
 * so and sees nothing else, and the API refuses them anyway.
 *
 * Two sections: the deployment default of every feature flag, and the
 * overrides of one user found by email. The answer a user gets is their
 * override, else the deployment default, else the code default (which reads
 * server configuration), in that order; the page shows each layer as text so
 * an admin can see why a flag is on or off.
 */
export default function AdminPage() {
  const { profile, loading } = useUserProfile();
  if (loading && !profile) return null;
  if (profile?.instanceAdmin !== true)
    return (
      <p className="text-sm text-gray-600" role="status">
        Only administrators of this Mike server can open this page.
      </p>
    );
  return (
    <div className="space-y-8">
      <DeploymentDefaults />
      <UserOverrides />
    </div>
  );
}

/** "Server configuration" vs "Set here", so an admin sees where a default comes from. */
function defaultSource(flag: FeatureFlagSummary): string {
  return flag.deploymentDefault === null
    ? `Default from server configuration: ${flag.codeDefault ? "on" : "off"}.`
    : `Set here; server configuration says ${flag.codeDefault ? "on" : "off"}.`;
}

function DeploymentDefaults() {
  const [flags, setFlags] = useState<FeatureFlagSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [busyKey, setBusyKey] = useState<FeatureFlagKey | null>(null);
  // Only the newest change may settle the list; a slower earlier save that
  // resolves late must not overwrite it.
  const requestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    getAdminFeatureFlags()
      .then((loaded) => {
        if (!cancelled) setFlags(loaded.flags);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadVersion]);

  const save = useCallback(
    async (key: FeatureFlagKey, enabled: boolean | null) => {
      const request = ++requestRef.current;
      setBusyKey(key);
      try {
        const saved: AdminFeatureFlagsResponse =
          await setAdminFeatureFlagDefault(key, enabled);
        if (request === requestRef.current) setFlags(saved.flags);
      } catch (error) {
        notifyError(error, {
          action: "change the feature flag default",
          onRetry: () => void save(key, enabled),
        });
      } finally {
        if (request === requestRef.current) setBusyKey(null);
      }
    },
    [],
  );

  return (
    <section className="space-y-3" aria-labelledby="feature-flag-defaults">
      <SettingsHeading id="feature-flag-defaults">Feature flags</SettingsHeading>
      <SettingsDescription>
        What every account on this server gets, unless an override below says
        otherwise. A flag with no choice here follows the server configuration.
      </SettingsDescription>
      <GlassCardUI>
        {loadError ? (
          <SettingsRow>
            <p className="text-sm text-red-600" role="alert">
              Could not load the feature flags.
            </p>
            <PillButtonUI
              tone="white"
              size="sm"
              onClick={() => {
                setLoadError(false);
                setLoadVersion((current) => current + 1);
              }}
            >
              Retry
            </PillButtonUI>
          </SettingsRow>
        ) : flags ? (
          flags.map((flag) => (
            <SettingsRow key={flag.key}>
              <div className="min-w-0 space-y-1">
                <SettingsLabel>{flag.label}</SettingsLabel>
                <SettingsDescription>{flag.description}</SettingsDescription>
                <p className="text-xs text-gray-500">
                  {defaultSource(flag)}
                  {flag.deploymentDefault !== null && (
                    <>
                      {" "}
                      <TextButtonUI
                        size="xs"
                        disabled={busyKey !== null}
                        onClick={() => void save(flag.key, null)}
                      >
                        Use server configuration
                      </TextButtonUI>
                    </>
                  )}
                </p>
              </div>
              <ToggleSwitchUI
                checked={flag.effectiveDefault}
                disabled={busyKey !== null}
                aria-busy={busyKey === flag.key}
                aria-label={`${flag.label} default`}
                onCheckedChange={(checked) => void save(flag.key, checked)}
              />
            </SettingsRow>
          ))
        ) : (
          <FlagRowsSkeleton />
        )}
      </GlassCardUI>
    </section>
  );
}

function FlagRowsSkeleton() {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <SettingsRow key={row}>
          <div className="min-w-0 space-y-2">
            <div
              className="h-4 w-40 max-w-full animate-pulse rounded bg-app-surface"
              aria-hidden="true"
            />
            <div
              className="h-3 w-72 max-w-full animate-pulse rounded bg-app-surface"
              aria-hidden="true"
            />
          </div>
          <div
            className="h-5 w-9 shrink-0 animate-pulse rounded-full bg-app-surface"
            aria-hidden="true"
          />
        </SettingsRow>
      ))}
    </>
  );
}

type OverrideChoice = "default" | "on" | "off";

function overrideChoice(override: boolean | null): OverrideChoice {
  return override === null ? "default" : override ? "on" : "off";
}

function overrideValue(choice: string): boolean | null {
  return choice === "default" ? null : choice === "on";
}

function UserOverrides() {
  const [email, setEmail] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [user, setUser] = useState<AdminUserFeatureFlags | null>(null);
  const [definitions, setDefinitions] = useState<FeatureFlagSummary[] | null>(
    null,
  );
  const [busyKey, setBusyKey] = useState<FeatureFlagKey | null>(null);
  const requestRef = useRef(0);

  // Labels and descriptions come from the same list the defaults use.
  useEffect(() => {
    let cancelled = false;
    getAdminFeatureFlags()
      .then((loaded) => {
        if (!cancelled) setDefinitions(loaded.flags);
      })
      .catch(() => {
        /* The defaults section reports this; the rows fall back to keys. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const lookUp = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    const request = ++requestRef.current;
    setLookingUp(true);
    setLookupError(null);
    try {
      const found = await getAdminUserFeatureFlags(trimmed);
      if (request === requestRef.current) setUser(found);
    } catch (error) {
      if (request !== requestRef.current) return;
      setUser(null);
      // "No account has that email address." is the ordinary outcome here,
      // so it is shown in place rather than as a warning.
      const described = describeError(error);
      setLookupError(
        described.kind === "not_found"
          ? "No account has that email address."
          : described.message,
      );
    } finally {
      if (request === requestRef.current) setLookingUp(false);
    }
  };

  const save = useCallback(
    async (userId: string, key: FeatureFlagKey, enabled: boolean | null) => {
      const request = ++requestRef.current;
      setBusyKey(key);
      try {
        const saved = await setAdminUserFeatureFlag(userId, key, enabled);
        if (request === requestRef.current) setUser(saved);
      } catch (error) {
        notifyError(error, {
          action: "change the feature flag for this user",
          onRetry: () => void save(userId, key, enabled),
        });
      } finally {
        if (request === requestRef.current) setBusyKey(null);
      }
    },
    [],
  );

  const definitionFor = (key: FeatureFlagKey) =>
    definitions?.find((flag) => flag.key === key);

  return (
    <section className="space-y-3" aria-labelledby="feature-flag-overrides">
      <SettingsHeading id="feature-flag-overrides">User overrides</SettingsHeading>
      <SettingsDescription>
        Turn a flag on or off for one account, whatever the default. Find the
        account by the email address it signed up with.
      </SettingsDescription>
      <GlassCardUI>
        <SettingsRow layout="stacked">
          <form
            className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center"
            onSubmit={(event) => void lookUp(event)}
          >
            <label htmlFor="admin-user-email" className="sr-only">
              Email address
            </label>
            <SettingsTextInput
              id="admin-user-email"
              type="email"
              autoComplete="off"
              placeholder="person@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="sm:max-w-sm"
            />
            <PillButtonUI
              type="submit"
              tone="white"
              size="sm"
              disabled={lookingUp || !email.trim()}
              aria-busy={lookingUp}
            >
              Look up
            </PillButtonUI>
          </form>
          {lookupError && (
            <p className="text-sm text-red-600" role="alert">
              {lookupError}
            </p>
          )}
        </SettingsRow>
        {user && (
          <>
            <SettingsRow>
              <div className="min-w-0 space-y-1">
                <SettingsLabel>{user.displayName ?? user.email}</SettingsLabel>
                {user.displayName && (
                  <SettingsDescription>{user.email}</SettingsDescription>
                )}
              </div>
            </SettingsRow>
            {user.flags.map((flag) => {
              const definition = definitionFor(flag.key);
              const defaultLabel = definition
                ? definition.effectiveDefault
                  ? "on"
                  : "off"
                : flag.override === null
                  ? flag.enabled
                    ? "on"
                    : "off"
                  : "unknown";
              const options: SettingsSelectOption[] = [
                {
                  value: "default",
                  label: `Default (${defaultLabel})`,
                  description: `Follows the deployment default, currently ${defaultLabel}.`,
                },
                { value: "on", label: "On", description: "On for this account." },
                { value: "off", label: "Off", description: "Off for this account." },
              ];
              return (
                <SettingsSelectRow
                  key={flag.key}
                  id={`admin-flag-${flag.key}`}
                  label={definition?.label ?? flag.key}
                  options={options}
                  value={busyKey === flag.key ? null : overrideChoice(flag.override)}
                  onChange={(choice) =>
                    void save(user.userId, flag.key, overrideValue(choice))
                  }
                />
              );
            })}
          </>
        )}
      </GlassCardUI>
    </section>
  );
}
