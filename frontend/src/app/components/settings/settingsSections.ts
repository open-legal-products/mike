"use client";

import {
    createContext,
    useContext,
    type ComponentType,
    type ReactNode,
} from "react";

/** One section of a settings area: a card on its overview page. */
export interface SettingsSection {
    id: string;
    label: string;
    /** What the section holds, in one line under its name on the overview. */
    description: string;
    href: string;
    icon: ComponentType<{ className?: string }>;
    /** Drawn after the name, as a count of pending invitations. */
    badge?: ReactNode;
}

/** A card of sections on the overview, under its heading when it has one. */
export interface SettingsSectionGroup {
    id: string;
    label?: string;
    sections: SettingsSection[];
}

/**
 * A settings area (a person's Settings, an organization's): its name, its
 * overview page, and the sections the caller is offered there, `null` until
 * those are known.
 */
export interface SettingsArea {
    title: string;
    rootHref: string;
    groups: SettingsSectionGroup[] | null;
}

export const SettingsAreaContext = createContext<SettingsArea | null>(null);

/** The settings area around the page, from SettingsShell. */
export function useSettingsArea(): SettingsArea | null {
    return useContext(SettingsAreaContext);
}

/** The section the address is in, if it is in one the area offers. */
export function activeSettingsSection(
    pathname: string,
    groups: SettingsSectionGroup[] | null,
): SettingsSection | undefined {
    return groups
        ?.flatMap((group) => group.sections)
        .find(
            (section) =>
                pathname === section.href ||
                pathname.startsWith(`${section.href}/`),
        );
}
