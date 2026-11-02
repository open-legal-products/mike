"use client";

import { useId } from "react";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { FieldLabel, FormTextInput } from "@/app/components/ui/form-field";
import type { PlaybookContent } from "@/app/lib/mikeApi";
import { PlaybookListField } from "./PlaybookListField";
import { PLAYBOOK_JURISDICTION_OPTIONS } from "./playbookJurisdictions";

/** What the new-playbook and details modals edit. */
export type PlaybookDetails = Pick<
  PlaybookContent,
  "name" | "representedParty" | "documentTypes" | "jurisdictions" | "description"
>;

export const EMPTY_PLAYBOOK_DETAILS: PlaybookDetails = {
  name: "",
  representedParty: "",
  documentTypes: [],
  jurisdictions: [],
  description: "",
};

export function playbookDetailsOf(content: PlaybookContent): PlaybookDetails {
  return {
    name: content.name,
    representedParty: content.representedParty,
    documentTypes: content.documentTypes,
    jurisdictions: content.jurisdictions,
    description: content.description,
  };
}

export function trimPlaybookDetails(details: PlaybookDetails): PlaybookDetails {
  return {
    ...details,
    name: details.name.trim(),
    representedParty: details.representedParty.trim(),
    description: details.description.trim(),
  };
}

export function samePlaybookDetails(a: PlaybookDetails, b: PlaybookDetails) {
  return (
    a.name === b.name &&
    a.representedParty === b.representedParty &&
    a.description === b.description &&
    a.documentTypes.join("\n") === b.documentTypes.join("\n") &&
    a.jurisdictions.join("\n") === b.jurisdictions.join("\n")
  );
}

export function PlaybookDetailsFields({
  value,
  onChange,
  disabled = false,
  autoFocus = false,
}: {
  value: PlaybookDetails;
  onChange: (value: PlaybookDetails) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const nameId = useId();
  const partyId = useId();
  const descriptionId = useId();
  return (
    <>
      <div>
        <FieldLabel htmlFor={nameId}>Playbook name</FieldLabel>
        <FormTextInput
          id={nameId}
          value={value.name}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
          placeholder="Add playbook name"
          variant="minimal"
          maxLength={200}
          disabled={disabled}
          autoFocus={autoFocus}
        />
      </div>
      <div>
        <FieldLabel htmlFor={partyId}>Represented party</FieldLabel>
        <FormTextInput
          id={partyId}
          value={value.representedParty}
          onChange={(event) =>
            onChange({ ...value, representedParty: event.target.value })
          }
          placeholder="Buyer, Licensee"
          disabled={disabled}
        />
      </div>
      <PlaybookListField
        label="Document types"
        value={value.documentTypes}
        placeholder="NDA, MSA"
        onChange={(documentTypes) => onChange({ ...value, documentTypes })}
        disabled={disabled}
      />
      <PlaybookListField
        label="Jurisdictions"
        value={value.jurisdictions}
        placeholder="England and Wales, New York"
        options={PLAYBOOK_JURISDICTION_OPTIONS}
        onChange={(jurisdictions) => onChange({ ...value, jurisdictions })}
        disabled={disabled}
      />
      <div>
        <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
        <ModalTextarea
          id={descriptionId}
          value={value.description}
          onChange={(event) =>
            onChange({ ...value, description: event.target.value })
          }
          placeholder="What this playbook is for"
          disabled={disabled}
        />
      </div>
    </>
  );
}
