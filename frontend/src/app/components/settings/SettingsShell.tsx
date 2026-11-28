"use client";

import { useMemo, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PageHeader } from "@/app/components/shared/PageHeader";
import {
    activeSettingsSection,
    SettingsAreaContext,
    type SettingsSectionGroup,
} from "@/app/components/settings/settingsSections";

/**
 * The frame every settings area shares. A section has the page header, its
 * breadcrumbs naming the area and the open section ("Settings › Memory"),
 * with the section below. The area's own address is its overview, every
 * section as a card (SettingsOverview); the area's name leads back there. The
 * overview has no page header: the area's name heads its centre column, with
 * the search beneath. A person's settings and an organization's use the same
 * one, so the two read as the same kind of place.
 */
export function SettingsShell({
    title,
    rootHref,
    groups,
    search,
    children,
}: {
    /** The area's name: "Settings", "Organization Settings". */
    title: string;
    /** The area's overview page. */
    rootHref: string;
    /** The sections the caller is offered, `null` until they are known. */
    groups: SettingsSectionGroup[] | null;
    /**
     * The area's search, when it has one: a `button` at the right end of a
     * section's header, a `field` under the overview's heading.
     */
    search?: (variant: "button" | "field") => ReactNode;
    children: ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const atRoot = pathname === rootHref;
    const current = atRoot ? undefined : activeSettingsSection(pathname, groups);
    const area = useMemo(
        () => ({ title, rootHref, groups }),
        [title, rootHref, groups],
    );

    return (
        <SettingsAreaContext.Provider value={area}>
            <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
                {atRoot ? null : (
                    <>
                        {/* The breadcrumbs are the visible title; the page
                            keeps its heading for assistive tech. */}
                        <h1 className="sr-only">{title}</h1>
                        <PageHeader
                            shrink
                            breadcrumbs={[
                                {
                                    label: title,
                                    onClick: () => router.push(rootHref),
                                    title: `Back to ${title}`,
                                },
                                current
                                    ? { label: current.label, cursor: "text" }
                                    : // Before the area knows its sections.
                                      { loading: true, skeletonClassName: "w-24" },
                            ]}
                            actions={
                                search
                                    ? [
                                          {
                                              type: "custom",
                                              render: search("button"),
                                          },
                                      ]
                                    : undefined
                            }
                        />
                    </>
                )}
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <main className="@container/settings mx-auto w-full max-w-3xl px-6 pb-10 pt-2">
                        {atRoot ? (
                            <div
                                data-slot="settings-overview-heading"
                                className="flex flex-col items-center gap-4 pb-6 pt-8 text-center"
                            >
                                <h1 className="font-serif text-2xl font-medium text-gray-900">
                                    {title}
                                </h1>
                                {search ? (
                                    <div className="w-full max-w-md">
                                        {search("field")}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                        {children}
                    </main>
                </div>
            </div>
        </SettingsAreaContext.Provider>
    );
}
