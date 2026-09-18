"use client";

import { useEffect, useRef, useState } from "react";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import {
  personalisationInitialValues,
  type PersonalisationField,
  usePersonalisationFields,
} from "@/app/components/settings/PersonalisationFields";
import { SettingsPersonalisationFields } from "@/app/components/settings/SettingsPersonalisationFields";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import type { PersonalisationDetails } from "@/app/lib/mikeApi";

function fieldStatus(
  field: PersonalisationField,
  savingField: PersonalisationField | null,
  savedField: PersonalisationField | null,
) {
  if (savingField === field) return "Saving...";
  if (savedField === field) return "Saved";
  return null;
}

export default function PersonalisationPage() {
  const { profile } = useUserProfile();
  if (!profile) return null;

  return (
    <PersonalisationForm initial={personalisationInitialValues(profile)} />
  );
}

function PersonalisationForm({
  initial,
}: {
  initial: ReturnType<typeof personalisationInitialValues>;
}) {
  const { updatePersonalisation } = useUserProfile();
  const [pendingField, setPendingField] = useState<PersonalisationField | null>(
    null,
  );
  const [savingField, setSavingField] = useState<PersonalisationField | null>(
    null,
  );
  const [savedField, setSavedField] = useState<PersonalisationField | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const form = usePersonalisationFields(initial, (field) => {
    setPendingField(field);
    setError(null);
  });
  const initialSnapshot = JSON.stringify({
    jurisdiction: initial.jurisdiction || null,
    practiceSetting: initial.practiceSetting,
    professionalTitle: initial.professionalTitle,
    practiceAreas: initial.practiceAreas,
  });
  const persistedSnapshotRef = useRef(initialSnapshot);
  const latestSnapshotRef = useRef(initialSnapshot);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // A half-finished "Other …" box (ticked but empty) must not block
    // saves of unrelated fields, and must never overwrite the stored
    // value for its own group with a transient empty state — so those
    // groups fall back to their last persisted values here.
    const persisted = JSON.parse(
      persistedSnapshotRef.current,
    ) as PersonalisationDetails;
    const details: PersonalisationDetails = {
      ...form.details,
      ...(form.invalidGroups.includes("jurisdiction")
        ? { jurisdiction: persisted.jurisdiction }
        : {}),
      ...(form.invalidGroups.includes("practiceAreas")
        ? { practiceAreas: persisted.practiceAreas }
        : {}),
    };
    const snapshot = JSON.stringify(details);
    latestSnapshotRef.current = snapshot;
    flushRef.current = null;
    // No per-field "is the edited group invalid" guard here: the
    // substitution above already neutralises invalid groups, so the
    // snapshot comparison alone decides. A guard keyed on the LAST
    // edited field would drop an earlier still-pending change (edit
    // Title, then tick an empty "Other" inside the debounce window —
    // the Title edit must still be saved).
    if (!pendingField || snapshot === persistedSnapshotRef.current) {
      return;
    }

    const field = pendingField;
    const fire = () => {
      flushRef.current = null;
      saveChainRef.current = saveChainRef.current.then(async () => {
        setSavingField(field);
        setSavedField(null);
        setError(null);
        const success = await updatePersonalisation(details);
        if (success) persistedSnapshotRef.current = snapshot;
        setSavingField((current) => (current === field ? null : current));
        if (latestSnapshotRef.current !== snapshot) return;
        if (!success) {
          // The profile context classified the failure and raised the toast;
          // this row keeps only the status and its own Retry.
          setError("Not saved");
          return;
        }
        setSavedField(field);
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
        savedTimerRef.current = setTimeout(() => {
          setSavedField((current) => (current === field ? null : current));
        }, 2000);
      });
    };
    const timeout = setTimeout(fire, 400);
    flushRef.current = fire;

    return () => clearTimeout(timeout);
  }, [
    form.details,
    form.invalidGroups,
    pendingField,
    retryVersion,
    updatePersonalisation,
  ]);

  useEffect(
    () => () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      // A save still inside its debounce window when the user leaves
      // the page fires immediately instead of being dropped.
      flushRef.current?.();
    },
    [],
  );

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SettingsHeading>Personalisation</SettingsHeading>
        <SettingsDescription>
          Tell Mike about your role and practice so responses can be tailored to
          your professional context.
        </SettingsDescription>
        <SettingsCard>
          <SettingsPersonalisationFields
            form={form}
            practiceAreasAriaLabel="Practice areas"
            statusFor={(field) => fieldStatus(field, savingField, savedField)}
          />

          {form.validationError && !error && (
            <SettingsRow layout="stacked">
              <div
                className="flex items-center justify-end text-xs"
                aria-live="polite"
              >
                <span className="text-red-600" role="alert">
                  {form.validationError}
                </span>
              </div>
            </SettingsRow>
          )}

          {error && (
            <SettingsRow layout="stacked">
              <div
                className="flex items-center justify-end gap-2 text-xs"
                aria-live="polite"
              >
                <span className="text-red-600" role="alert">
                  {error}
                </span>
                <button
                  type="button"
                  onClick={() => setRetryVersion((current) => current + 1)}
                  className="font-medium text-gray-700 hover:text-gray-950"
                >
                  Retry
                </button>
              </div>
            </SettingsRow>
          )}
        </SettingsCard>
      </section>
    </div>
  );
}
