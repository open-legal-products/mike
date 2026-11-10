"use client";

import { useId } from "react";
import type { ContentVisibility } from "@/app/components/shared/types";
import { FieldLabel } from "@/app/components/ui/form-field";
import { ModalSegmentedToggle } from "./ModalSegmentedToggle";

const OPTIONS: { value: ContentVisibility; label: string }[] = [
    { value: "private", label: "Private" },
    { value: "organization", label: "Public" },
];

/**
 * The "Organisational Access" choice for an organization's project or
 * workflow, as it appears among the item's details. The label names what
 * Private and Public are relative to: "Public" is public to the
 * organization, not to the world.
 *
 *   Private  only the individuals it is shared with can open it (the default)
 *   Public   every member of the organization can open and edit it; a
 *            public playbook can be viewed and run, and is edited only by
 *            the people given that role
 *
 * It is not offered for a personal item, which has no "everyone" to be opened
 * to and is always shared by naming people.
 */
export function AccessVisibilityField({
    visibility,
    onChange,
    organizationName,
    resourceNoun,
    disabled = false,
}: {
    visibility: ContentVisibility;
    onChange: (visibility: ContentVisibility) => void;
    organizationName?: string | null;
    resourceNoun: "project" | "workflow" | "playbook";
    disabled?: boolean;
}) {
    const labelId = useId();
    const descriptionId = useId();
    const organizationLabel = organizationName || "the organisation";
    const publicAbility =
        resourceNoun === "playbook" ? "view and run" : "open and edit";

    return (
        <div
            data-slot="access-visibility-field"
            role="group"
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
        >
            <FieldLabel as="p" id={labelId}>
                Organisational Access
            </FieldLabel>
            {/* The choice, and beside it what the choice means. The text takes
                the room the toggle leaves and wraps within it; where there is
                too little for a few words it drops onto its own line. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <ModalSegmentedToggle
                    value={visibility}
                    onChange={onChange}
                    options={OPTIONS}
                    disabled={disabled}
                    className="shrink-0"
                />
                <p
                    id={descriptionId}
                    data-slot="access-visibility-description"
                    className="min-w-0 flex-[1_1_8rem] text-xs leading-4 text-gray-500"
                >
                    {visibility === "organization"
                        ? `Everyone in ${organizationLabel} can ${publicAbility} this ${resourceNoun}.`
                        : `Only the people you share this ${resourceNoun} with can open it.`}
                </p>
            </div>
        </div>
    );
}
