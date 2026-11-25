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
 * The frame every settings area shares: the page header, its breadcrumbs
 * naming the area and the open section ("Settings › Memory"), with the open
 * section below. The area's own address is its overview, every section as a
 * card (SettingsOverview); the area's name leads back there. A person's
 * settings and an organization's use the same one, so the two read as the
 * same kind of place.
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
    /** A search box drawn at the right end of the header, when the area has one. */
    search?: ReactNode;
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
                {/* The breadcrumbs are the visible title; the page keeps its
                    heading for assistive tech. */}
                <h1 className="sr-only">{title}</h1>
                <PageHeader
                    shrink
                    breadcrumbs={
                        atRoot
                            ? [{ label: title, cursor: "text" }]
                            : [
                                  {
                                      label: title,
                                      onClick: () => router.push(rootHref),
                                      title: `Back to ${title}`,
                                  },
                                  current
                                      ? { label: current.label, cursor: "text" }
                                      : // Before the area knows its sections.
                                        { loading: true, skeletonClassName: "w-24" },
                              ]
                    }
                    actions={
                        search
                            ? [
                                  {
                                      type: "custom",
                                      render: search,
                                  },
                              ]
                            : undefined
                    }
                />
                <div className="min-h-0 flex-1 overflow-y-auto">
                    <main className="@container/settings mx-auto w-full max-w-3xl px-6 pb-10 pt-2">
                        {children}
                    </main>
                </div>
            </div>
        </SettingsAreaContext.Provider>
    );
}
