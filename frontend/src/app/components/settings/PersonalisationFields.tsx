"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { authInputUIClassName } from "@/shared/ui/AuthStylesUI";
import { InputUI } from "@/shared/ui/InputUI";
import { OptionPill } from "@/app/components/ui/option-pill";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
  Dropdown,
  DropdownCheckboxItem,
  DropdownContent,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownTrigger,
} from "@/shared/ui/dropdown";
import { cn } from "@/app/lib/utils";
import type { PersonalisationDetails } from "@/app/lib/mikeApi";
import {
  COUNTRY_OPTIONS,
  OTHER_JURISDICTION_OPTION,
  PRACTICE_AREA_OPTIONS,
  PRACTICE_SETTING_OPTIONS,
  PROFESSIONAL_TITLE_OPTIONS,
  type PracticeSetting,
  type ProfessionalTitle,
} from "@/app/onboarding/options";

const COMMON_PRACTICE_AREAS = PRACTICE_AREA_OPTIONS.filter(
  (area) => area !== "Other",
);
const NOT_SET_OPTION = "__not_set__";

export type PersonalisationField =
  | "professionalTitle"
  | "practiceSetting"
  | "jurisdiction"
  | "otherJurisdiction"
  | "practiceAreas"
  | "otherPracticeArea";

export type PersonalisationFieldGroup =
  "professionalTitle" | "practiceSetting" | "jurisdiction" | "practiceAreas";

export interface PersonalisationInitialValues {
  jurisdiction: string;
  practiceSetting: PracticeSetting | null;
  professionalTitle: ProfessionalTitle | null;
  practiceAreas: string[];
}

export function personalisationInitialValues(profile: {
  jurisdiction: string | null;
  practiceSetting: PracticeSetting | null;
  professionalTitle: ProfessionalTitle | null;
  practiceAreas: string[];
}): PersonalisationInitialValues {
  return {
    jurisdiction: profile.jurisdiction ?? "",
    practiceSetting: profile.practiceSetting ?? null,
    professionalTitle: profile.professionalTitle ?? null,
    practiceAreas: profile.practiceAreas,
  };
}

export function usePersonalisationFields(
  initial: PersonalisationInitialValues,
  onFieldChange?: (field: PersonalisationField) => void,
) {
  const commonAreas = initial.practiceAreas.filter((area) =>
    COMMON_PRACTICE_AREAS.includes(
      area as (typeof COMMON_PRACTICE_AREAS)[number],
    ),
  );
  const customAreas = initial.practiceAreas.filter(
    (area) =>
      !COMMON_PRACTICE_AREAS.includes(
        area as (typeof COMMON_PRACTICE_AREAS)[number],
      ),
  );
  const initialUsesOtherJurisdiction =
    !!initial.jurisdiction &&
    !COUNTRY_OPTIONS.includes(
      initial.jurisdiction as (typeof COUNTRY_OPTIONS)[number],
    );
  const [jurisdictionChoice, setJurisdictionChoiceState] = useState(
    initialUsesOtherJurisdiction
      ? OTHER_JURISDICTION_OPTION
      : initial.jurisdiction,
  );
  const [otherJurisdiction, setOtherJurisdictionState] = useState(
    initialUsesOtherJurisdiction ? initial.jurisdiction : "",
  );
  const [practiceSetting, setPracticeSettingState] =
    useState<PracticeSetting | null>(initial.practiceSetting);
  const [professionalTitle, setProfessionalTitleState] =
    useState<ProfessionalTitle | null>(initial.professionalTitle);
  const [selectedAreas, setSelectedAreas] = useState(commonAreas);
  const [otherSelected, setOtherSelectedState] = useState(
    customAreas.length > 0,
  );
  const [otherArea, setOtherAreaState] = useState(customAreas[0] ?? "");

  const practiceAreas = useMemo(
    () => [
      ...selectedAreas,
      ...(otherSelected && otherArea.trim() ? [otherArea.trim()] : []),
    ],
    [otherArea, otherSelected, selectedAreas],
  );
  const jurisdiction =
    jurisdictionChoice === OTHER_JURISDICTION_OPTION
      ? otherJurisdiction.trim()
      : jurisdictionChoice;
  const details = useMemo<PersonalisationDetails>(
    () => ({
      jurisdiction: jurisdiction || null,
      practiceSetting,
      professionalTitle,
      practiceAreas,
    }),
    [jurisdiction, practiceAreas, practiceSetting, professionalTitle],
  );

  const changed = (field: PersonalisationField) => onFieldChange?.(field);

  const jurisdictionIncomplete =
    jurisdictionChoice === OTHER_JURISDICTION_OPTION &&
    !otherJurisdiction.trim();
  const practiceAreasIncomplete = otherSelected && !otherArea.trim();
  const invalidGroups = useMemo<PersonalisationFieldGroup[]>(
    () => [
      ...(jurisdictionIncomplete ? (["jurisdiction"] as const) : []),
      ...(practiceAreasIncomplete ? (["practiceAreas"] as const) : []),
    ],
    [jurisdictionIncomplete, practiceAreasIncomplete],
  );

  return {
    jurisdictionChoice,
    otherJurisdiction,
    practiceSetting,
    professionalTitle,
    selectedAreas,
    otherSelected,
    otherArea,
    practiceAreas,
    details,
    invalidGroups,
    validationError: jurisdictionIncomplete
      ? "Enter your jurisdiction of practice"
      : practiceAreasIncomplete
        ? "Enter your other practice area"
        : null,
    setJurisdictionChoice(value: string) {
      setJurisdictionChoiceState(value);
      changed("jurisdiction");
    },
    setOtherJurisdiction(value: string) {
      setOtherJurisdictionState(value);
      changed("otherJurisdiction");
    },
    setPracticeSetting(value: PracticeSetting | null) {
      setPracticeSettingState(value);
      changed("practiceSetting");
    },
    setProfessionalTitle(value: ProfessionalTitle | null) {
      setProfessionalTitleState(value);
      changed("professionalTitle");
    },
    toggleArea(area: string) {
      setSelectedAreas((current) =>
        current.includes(area)
          ? current.filter((item) => item !== area)
          : [...current, area],
      );
      changed("practiceAreas");
    },
    setOtherSelected(value: boolean) {
      setOtherSelectedState(value);
      changed("practiceAreas");
    },
    setOtherArea(value: string) {
      setOtherAreaState(value);
      changed("otherPracticeArea");
    },
  };
}

export type PersonalisationFieldsState = ReturnType<
  typeof usePersonalisationFields
>;

export function PersonalisationFields({
  form,
  order = [
    "professionalTitle",
    "practiceSetting",
    "jurisdiction",
    "practiceAreas",
  ],
  statusFor,
  practiceAreasAriaLabel,
  className,
  renderGroup,
}: {
  form: PersonalisationFieldsState;
  order?: readonly PersonalisationFieldGroup[];
  statusFor?: (field: PersonalisationField) => string | null;
  practiceAreasAriaLabel?: string;
  className?: string;
  renderGroup?: (
    group: PersonalisationFieldGroup,
    content: ReactNode,
  ) => ReactNode;
}) {
  const groups: Record<PersonalisationFieldGroup, ReactNode> = {
    professionalTitle: (
      <ProfileDropdown
        id="professional-title"
        label="Title"
        status={statusFor?.("professionalTitle")}
        value={form.professionalTitle}
        placeholder="Select a title"
        options={PROFESSIONAL_TITLE_OPTIONS.map((title) => ({
          value: title,
          label: title,
        }))}
        onChange={(value) =>
          form.setProfessionalTitle(value ? (value as ProfessionalTitle) : null)
        }
      />
    ),
    practiceSetting: (
      <ProfileDropdown
        id="practice-setting"
        label="Professional setting"
        status={statusFor?.("practiceSetting")}
        value={form.practiceSetting}
        placeholder="Select a professional setting"
        options={PRACTICE_SETTING_OPTIONS}
        onChange={(value) =>
          form.setPracticeSetting(value ? (value as PracticeSetting) : null)
        }
      />
    ),
    jurisdiction: (
      <>
        <ProfileDropdown
          id="jurisdiction"
          label="Jurisdiction of practice"
          status={statusFor?.("jurisdiction")}
          value={form.jurisdictionChoice || null}
          placeholder="Select a country"
          options={[
            ...COUNTRY_OPTIONS.map((country) => ({
              value: country,
              label: country,
            })),
            {
              value: OTHER_JURISDICTION_OPTION,
              label: OTHER_JURISDICTION_OPTION,
            },
          ]}
          onChange={form.setJurisdictionChoice}
          maxHeight
        />
        {form.jurisdictionChoice === OTHER_JURISDICTION_OPTION && (
          <div className="mt-4">
            <FieldLabelRow
              label="Other jurisdiction"
              htmlFor="other-jurisdiction"
              status={statusFor?.("otherJurisdiction")}
            />
            <InputUI
              id="other-jurisdiction"
              value={form.otherJurisdiction}
              onChange={(event) =>
                form.setOtherJurisdiction(event.target.value)
              }
              maxLength={100}
              placeholder="Enter your jurisdiction"
              className={`w-full ${authInputUIClassName}`}
            />
          </div>
        )}
      </>
    ),
    practiceAreas: (
      <div>
        <FieldLabelRow
          label="Practice areas"
          status={statusFor?.("practiceAreas")}
        />
        <Dropdown>
          <DropdownTrigger asChild>
            <button
              type="button"
              aria-label={practiceAreasAriaLabel}
              className={cn(
                "flex h-9 w-full items-center justify-between text-left text-sm outline-none",
                authInputUIClassName,
                form.practiceAreas.length === 0 && "text-gray-400",
              )}
            >
              <span className="truncate">
                {form.practiceAreas.length
                  ? `${form.practiceAreas.length} selected`
                  : "Select practice areas"}
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
            </button>
          </DropdownTrigger>
          <DropdownContent
            align="start"
            sideOffset={6}
            className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
          >
            {COMMON_PRACTICE_AREAS.map((area) => (
              <DropdownCheckboxItem
                key={area}
                checked={form.selectedAreas.includes(area)}
                onCheckedChange={() => form.toggleArea(area)}
                onSelect={(event) => event.preventDefault()}
              >
                {area}
              </DropdownCheckboxItem>
            ))}
            <DropdownCheckboxItem
              checked={form.otherSelected}
              onCheckedChange={(checked) =>
                form.setOtherSelected(checked === true)
              }
              onSelect={(event) => event.preventDefault()}
            >
              Other
            </DropdownCheckboxItem>
          </DropdownContent>
        </Dropdown>

        {form.practiceAreas.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {form.selectedAreas.map((area) => (
              <OptionPill
                key={area}
                onClick={() => form.toggleArea(area)}
                aria-label={`Remove ${area}`}
              >
                {area}
                <X className="h-3 w-3" />
              </OptionPill>
            ))}
            {form.otherSelected && form.otherArea.trim() && (
              <OptionPill
                onClick={() => form.setOtherSelected(false)}
                aria-label={`Remove ${form.otherArea.trim()}`}
              >
                {form.otherArea.trim()}
                <X className="h-3 w-3" />
              </OptionPill>
            )}
          </div>
        )}

        {form.otherSelected && (
          <div className="mt-4">
            <FieldLabelRow
              label="Other practice area"
              htmlFor="other-practice-area"
              status={statusFor?.("otherPracticeArea")}
            />
            <InputUI
              id="other-practice-area"
              value={form.otherArea}
              onChange={(event) => form.setOtherArea(event.target.value)}
              maxLength={100}
              placeholder="Enter your practice area"
              className={`w-full ${authInputUIClassName}`}
            />
          </div>
        )}
      </div>
    ),
  };

  return (
    <div className={className}>
      {order.map((group) => (
        <Fragment key={group}>
          {renderGroup ? (
            renderGroup(group, groups[group])
          ) : (
            <div>{groups[group]}</div>
          )}
        </Fragment>
      ))}
    </div>
  );
}

function ProfileDropdown({
  id,
  label,
  status,
  value,
  placeholder,
  options,
  onChange,
  maxHeight = false,
}: {
  id: string;
  label: string;
  status?: string | null;
  value: string | null;
  placeholder: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  maxHeight?: boolean;
}) {
  return (
    <div>
      <FieldLabelRow label={label} htmlFor={id} status={status} />
      <Dropdown>
        <DropdownTrigger asChild>
          <button
            id={id}
            type="button"
            aria-label={label}
            className={cn(
              "flex h-9 w-full items-center justify-between text-left text-sm outline-none",
              authInputUIClassName,
              !value && "text-gray-400",
            )}
          >
            <span className="truncate">
              {options.find((option) => option.value === value)?.label ??
                placeholder}
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
          </button>
        </DropdownTrigger>
        <DropdownContent
          align="start"
          sideOffset={6}
          className={cn(
            "w-[var(--radix-dropdown-menu-trigger-width)]",
            maxHeight && "max-h-72 overflow-y-auto",
          )}
        >
          <DropdownRadioGroup
            value={value ?? ""}
            onValueChange={(nextValue) =>
              onChange(nextValue === NOT_SET_OPTION ? "" : nextValue)
            }
          >
            <DropdownRadioItem value={NOT_SET_OPTION}>
              Not set
            </DropdownRadioItem>
            {options.map((option) => (
              <DropdownRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownRadioItem>
            ))}
          </DropdownRadioGroup>
        </DropdownContent>
      </Dropdown>
    </div>
  );
}

function FieldLabelRow({
  label,
  htmlFor,
  status,
}: {
  label: string;
  htmlFor?: string;
  status?: string | null;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      {htmlFor ? (
        <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      ) : (
        <FieldLabel as="p">{label}</FieldLabel>
      )}
      {status !== undefined && (
        <span className="text-xs text-gray-400" aria-live="polite">
          {status ?? ""}
        </span>
      )}
    </div>
  );
}
