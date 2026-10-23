"use client";

import { useEffect, useState, type FormEvent } from "react";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import {
  SETTINGS_CONTROL_CLASS,
  SettingsTextInput,
} from "@/app/components/settings/SettingsTextInput";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
  getOrgProfile,
  saveOrgProfile,
  type OrgProfile,
  type OrgProfileInput,
} from "@/app/lib/mikeApi";
import { isOrgAdmin } from "@/app/lib/permissions";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { cn } from "@/app/lib/utils";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { useOrganizationSettings } from "./OrganizationSettingsShell";

/**
 * The Workspace profile section of an organization's settings: facts about the
 * organization and the positions and instructions its owners and admins write
 * for the assistant. Every member can read it; owners and admins save it. The
 * server still decides every change.
 */

type Draft = {
  group_name: string;
  headquarters_jurisdiction: string;
  operating_jurisdictions: string;
  fiscal_year_end: string;
  reporting_currency: string;
  group_structure: string;
  house_positions: string;
  standing_instructions: string;
  reviewed_on: string;
};

const SHORT_FIELDS: ReadonlyArray<{
  key: Exclude<keyof Draft, "group_structure" | "house_positions" | "standing_instructions" | "reviewed_on">;
  label: string;
  placeholder: string;
}> = [
  { key: "group_name", label: "Group name", placeholder: "Example Group" },
  { key: "headquarters_jurisdiction", label: "Headquarters jurisdiction", placeholder: "NL" },
  { key: "operating_jurisdictions", label: "Operating jurisdictions", placeholder: "NL, DE, US" },
  { key: "fiscal_year_end", label: "Fiscal year end", placeholder: "12-31" },
  { key: "reporting_currency", label: "Reporting currency", placeholder: "EUR" },
];

const LONG_FIELDS: ReadonlyArray<{
  key: "group_structure" | "house_positions" | "standing_instructions";
  label: string;
}> = [
  { key: "group_structure", label: "Group structure" },
  { key: "house_positions", label: "House positions" },
  { key: "standing_instructions", label: "Standing instructions" },
];

function toDraft(profile: OrgProfile): Draft {
  return {
    group_name: profile.group_name ?? "",
    headquarters_jurisdiction: profile.headquarters_jurisdiction ?? "",
    operating_jurisdictions: profile.operating_jurisdictions.join(", "),
    fiscal_year_end: profile.fiscal_year_end ?? "",
    reporting_currency: profile.reporting_currency ?? "",
    group_structure: profile.group_structure ?? "",
    house_positions: profile.house_positions ?? "",
    standing_instructions: profile.standing_instructions ?? "",
    reviewed_on: profile.reviewed_on ?? "",
  };
}

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toInput(draft: Draft): OrgProfileInput {
  return {
    group_name: textOrNull(draft.group_name),
    headquarters_jurisdiction: textOrNull(draft.headquarters_jurisdiction),
    operating_jurisdictions: draft.operating_jurisdictions
      .split(",")
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean),
    fiscal_year_end: textOrNull(draft.fiscal_year_end),
    reporting_currency: textOrNull(draft.reporting_currency)?.toUpperCase() ?? null,
    group_structure: textOrNull(draft.group_structure),
    house_positions: textOrNull(draft.house_positions),
    standing_instructions: textOrNull(draft.standing_instructions),
    reviewed_on: textOrNull(draft.reviewed_on),
  };
}

type Status = "idle" | "saving" | "saved" | { error: string };

export function OrganizationProfileSettings() {
  const { orgId, org } = useOrganizationSettings();
  const canEdit = org !== null && isOrgAdmin(org.role);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  // The page mounts once per organization, so the profile is read once; the
  // flag drops a reply that arrives after the page has gone.
  useEffect(() => {
    let current = true;
    getOrgProfile(orgId).then(
      (profile) => {
        if (current) setDraft(toDraft(profile));
      },
      (error: unknown) => {
        if (current)
          setLoadError(
            userFacingApiError(error, "The workspace profile could not be loaded."),
          );
      },
    );
    return () => {
      current = false;
    };
  }, [orgId]);

  const update = (key: keyof Draft, value: string) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setStatus("idle");
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !canEdit || status === "saving") return;
    setStatus("saving");
    try {
      const saved = await saveOrgProfile(orgId, toInput(draft));
      setDraft(toDraft(saved));
      setStatus("saved");
    } catch (error) {
      setStatus({
        error: userFacingApiError(error, "The workspace profile could not be saved."),
      });
    }
  };

  const disabled = !canEdit || status === "saving";

  return (
    <section aria-labelledby="org-profile-heading" className="space-y-3">
      <SettingsHeading id="org-profile-heading">Workspace profile</SettingsHeading>
      <SettingsDescription>
        Reference context for each member&apos;s own chats in this workspace that
        no one else can see; project and tabular review chats do not get it. It
        is never an instruction and never a source.
      </SettingsDescription>
      <GlassCardUI>
        {loadError ? (
          <SettingsRow layout="stacked">
            <p className="text-sm text-red-600" role="alert">
              {loadError}
            </p>
          </SettingsRow>
        ) : !draft ? (
          <SettingsRow layout="stacked">
            <span className="block h-10 w-full animate-pulse rounded-lg bg-gray-200" />
          </SettingsRow>
        ) : (
          <form onSubmit={save} noValidate>
            {SHORT_FIELDS.map((field) => (
              <SettingsRow key={field.key} layout="stacked">
                <FieldLabel htmlFor={`org-profile-${field.key}`}>{field.label}</FieldLabel>
                <SettingsTextInput
                  id={`org-profile-${field.key}`}
                  type="text"
                  value={draft[field.key]}
                  placeholder={canEdit ? field.placeholder : undefined}
                  disabled={disabled}
                  onChange={(event) => update(field.key, event.target.value)}
                />
              </SettingsRow>
            ))}
            {LONG_FIELDS.map((field) => (
              <SettingsRow key={field.key} layout="stacked">
                <FieldLabel htmlFor={`org-profile-${field.key}`}>{field.label}</FieldLabel>
                <textarea
                  id={`org-profile-${field.key}`}
                  value={draft[field.key]}
                  disabled={disabled}
                  maxLength={4000}
                  rows={4}
                  onChange={(event) => update(field.key, event.target.value)}
                  className={cn("py-2", SETTINGS_CONTROL_CLASS)}
                />
              </SettingsRow>
            ))}
            <SettingsRow layout="stacked">
              <FieldLabel htmlFor="org-profile-reviewed_on">Reviewed on</FieldLabel>
              <SettingsTextInput
                id="org-profile-reviewed_on"
                type="date"
                value={draft.reviewed_on}
                disabled={disabled}
                onChange={(event) => update("reviewed_on", event.target.value)}
              />
            </SettingsRow>
            {canEdit ? (
              <SettingsRow>
                <div className="flex w-full items-center justify-end gap-3">
                  {typeof status === "object" ? (
                    <p className="text-sm text-red-600" role="alert">
                      {status.error}
                    </p>
                  ) : status === "saved" ? (
                    <span className="text-xs text-gray-400" aria-live="polite">
                      Saved
                    </span>
                  ) : null}
                  <PillButtonUI
                    type="submit"
                    tone="black"
                    size="sm"
                    disabled={status === "saving"}
                  >
                    Save
                  </PillButtonUI>
                </div>
              </SettingsRow>
            ) : (
              <SettingsRow>
                <SettingsLabel>Only owners and admins can change the profile.</SettingsLabel>
              </SettingsRow>
            )}
          </form>
        )}
      </GlassCardUI>
    </section>
  );
}
