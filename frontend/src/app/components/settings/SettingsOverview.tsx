"use client";

import { useId } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { GlassCardUI } from "@mike/ui";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import {
    useSettingsArea,
    type SettingsSection,
    type SettingsSectionGroup,
} from "@/app/components/settings/settingsSections";

const ROW_CLASS =
    "flex min-w-0 items-center gap-3 border-t border-gray-100 p-4 first:border-t-0";

/**
 * A settings area's starting page: every section it offers the caller, each
 * a row of its card with its icon, name and what it holds, leading to it.
 */
export function SettingsOverview() {
    const area = useSettingsArea();
    const groups = area?.groups ?? null;
    if (!groups) return <SettingsOverviewSkeleton />;
    return (
        <div className="space-y-8">
            {groups
                .filter((group) => group.sections.length > 0)
                .map((group) => (
                    <SettingsOverviewGroup key={group.id} group={group} />
                ))}
        </div>
    );
}

function SettingsOverviewGroup({ group }: { group: SettingsSectionGroup }) {
    const headingId = `settings-overview-${group.id}`;
    return (
        <section
            className="space-y-3"
            aria-labelledby={group.label ? headingId : undefined}
        >
            {group.label ? (
                <SettingsHeading id={headingId}>{group.label}</SettingsHeading>
            ) : null}
            <GlassCardUI>
                <ul>
                    {group.sections.map((section) => (
                        <li
                            key={section.id}
                            // The row's hover fill keeps to the card's corners.
                            className="overflow-hidden border-t border-gray-100 first:rounded-t-xl first:border-t-0 last:rounded-b-xl"
                        >
                            <SettingsOverviewRow section={section} />
                        </li>
                    ))}
                </ul>
            </GlassCardUI>
        </section>
    );
}

function SettingsOverviewRow({ section }: { section: SettingsSection }) {
    const Icon = section.icon;
    const labelId = useId();
    const descriptionId = useId();
    return (
        <Link
            href={section.href}
            // Named by the section alone; what it holds is its description.
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            className="group flex min-w-0 items-center gap-3 p-4 outline-none transition-colors hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
        >
            <Icon className="h-6 w-6 shrink-0" />
            <span className="min-w-0 flex-1">
                <span
                    id={labelId}
                    className="flex flex-wrap items-center text-sm font-medium text-gray-900"
                >
                    {section.label}
                    {section.badge ? <> {section.badge}</> : null}
                </span>
                <span id={descriptionId} className="block text-sm text-gray-500">
                    {section.description}
                </span>
            </span>
            <ChevronRight
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-gray-600"
            />
        </Link>
    );
}

/** Holds the overview's place, in the same rows, until its sections are known. */
function SettingsOverviewSkeleton() {
    return (
        <div className="space-y-8" aria-busy="true">
            <GlassCardUI>
                {[0, 1, 2].map((row) => (
                    <div key={row} className={ROW_CLASS}>
                        <div className="h-6 w-6 shrink-0 animate-pulse rounded-md bg-gray-100" />
                        <div className="min-w-0 flex-1 space-y-2">
                            <div className="h-4 w-32 animate-pulse rounded bg-gray-100" />
                            <div className="h-4 w-56 max-w-full animate-pulse rounded bg-gray-100" />
                        </div>
                    </div>
                ))}
            </GlassCardUI>
        </div>
    );
}
