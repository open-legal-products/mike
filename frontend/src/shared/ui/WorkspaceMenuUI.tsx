"use client";

import { Check } from "lucide-react";
import {
    DropdownLabel,
    DropdownRadioGroup,
    DropdownRadioItem,
    DropdownSeparator,
} from "./dropdown";
import {
    workspaceMenuOptions,
    type WorkspaceOrg,
} from "../lib/workspaceSelection";

export interface WorkspaceMenuUIProps {
    /** The active workspace: "personal" or an organization id. */
    workspaceId: string | null;
    /** The caller's organizations; `null` until first loaded. */
    organizations: readonly WorkspaceOrg[] | null;
    /** Called with the chosen workspace id. */
    onSelect: (workspaceId: string) => void;
    /** Ends the section with a separator, for menus with items below it. */
    trailingSeparator?: boolean;
}

/**
 * The "Workspace" section of an account menu, for the web app's sidebar and
 * the Word add-in: Personal and each organization as radio items, so the
 * active one is announced as checked rather than shown by the tick alone.
 * Renders nothing for somebody with no organizations — with nowhere else to
 * be, there is nothing to choose between. Place it inside a `DropdownContent`.
 */
export function WorkspaceMenuUI({
    workspaceId,
    organizations,
    onSelect,
    trailingSeparator = false,
}: WorkspaceMenuUIProps) {
    const options = workspaceId ? workspaceMenuOptions(organizations) : null;
    if (!workspaceId || !options) return null;
    return (
        <>
            {/* Same inset as the items below, so the heading sits over their
                text; normal case, and the size and weight of the sidebar's
                own section headings. */}
            <DropdownLabel className="px-2 text-xs font-semibold normal-case tracking-normal">
                Workspace
            </DropdownLabel>
            <DropdownRadioGroup
                aria-label="Workspace"
                value={workspaceId}
                onValueChange={onSelect}
                className="max-h-44 overflow-y-auto"
            >
                {options.map((option) => (
                    <DropdownRadioItem
                        key={option.id}
                        value={option.id}
                        className="min-h-8 gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-gray-700"
                    >
                        <span className="min-w-0 flex-1 whitespace-normal break-words">
                            {option.name}
                        </span>
                        {option.id === workspaceId ? (
                            <Check
                                aria-hidden="true"
                                className="h-3.5 w-3.5 shrink-0 text-gray-500"
                            />
                        ) : null}
                    </DropdownRadioItem>
                ))}
            </DropdownRadioGroup>
            {trailingSeparator ? <DropdownSeparator className="my-1" /> : null}
        </>
    );
}
