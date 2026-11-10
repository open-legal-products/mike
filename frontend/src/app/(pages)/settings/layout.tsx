"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useOrganizationInvitationCount } from "@/app/hooks/useOrganizationInvitationCount";
import { useMemberDataActions } from "@/app/hooks/useMemberDataActions";
import {
    SettingsShell,
    type SettingsShellTab,
} from "@/app/components/settings/SettingsShell";
import { SettingsSearch } from "@/app/components/settings/SettingsSearch";
import { SETTINGS_SEARCH_ENTRIES } from "@/app/lib/settingsSearch";

const TABS: SettingsShellTab[] = [
    { id: "account", label: "Account", href: "/settings" },
    {
        id: "personalisation",
        label: "Personalisation",
        href: "/settings/personalisation",
    },
    { id: "memory", label: "Memory", href: "/settings/memory" },
    { id: "appearance", label: "Appearance", href: "/settings/appearance" },
    { id: "features", label: "Features", href: "/settings/features" },
    {
        id: "privacy-data",
        label: "Privacy & Data",
        href: "/settings/privacy-data",
    },
    {
        id: "my-activity",
        label: "My Activity",
        href: "/settings/my-activity",
    },
    { id: "security", label: "Security", href: "/settings/security" },
    { id: "models", label: "Model Preferences", href: "/settings/models" },
    {
        id: "byok",
        label: "Bring Your Own Keys",
        href: "/settings/byok",
    },
    { id: "connectors", label: "Connectors", href: "/settings/connectors" },
    // The organizations the person belongs to, and their invitations. Each
    // organization's own settings are a separate area, opened from here or
    // from the account menu.
    {
        id: "organizations",
        label: "Organizations",
        href: "/settings/organizations",
    },
];

export default function SettingsLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const { user, isAuthenticated, authLoading } = useAuth();
    const invitationCount = useOrganizationInvitationCount(
        isAuthenticated && !authLoading ? user?.id : undefined,
    );
    // Privacy & Data has nothing to offer a member of an organization whose
    // owners allow neither exports nor bulk deletes, so it is not listed.
    const { canExport, canDelete } = useMemberDataActions();
    const hidePrivacyData = !canExport && !canDelete;
    const visibleTabs = useMemo(
        () =>
            TABS.filter(
                (tab) => !(hidePrivacyData && tab.id === "privacy-data"),
            ),
        [hidePrivacyData],
    );
    // Search only what is listed: an entry on a hidden tab would open a page
    // the person is not offered.
    const searchEntries = useMemo(() => {
        const visibleTabIds = new Set(visibleTabs.map((tab) => tab.id));
        return SETTINGS_SEARCH_ENTRIES.filter((entry) =>
            visibleTabIds.has(entry.tabId),
        );
    }, [visibleTabs]);

    useEffect(() => {
        if (!authLoading && !isAuthenticated) {
            router.push("/");
        }
    }, [isAuthenticated, authLoading, router]);

    if (authLoading) {
        return (
            <div className="h-dvh flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    // My Activity is linked from Settings but uses the full table-page layout.
    if (pathname === "/settings/my-activity") {
        return children;
    }

    return (
        <SettingsShell
            title="Settings"
            navLabel="Settings"
            search={<SettingsSearch entries={searchEntries} />}
            tabs={visibleTabs.map((tab) =>
                tab.id === "organizations" && invitationCount > 0
                    ? {
                          ...tab,
                          badge: (
                              <span className="ml-2 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-semibold tabular-nums text-white">
                                  {invitationCount}{" "}
                                  <span className="sr-only">
                                      {invitationCount === 1
                                          ? "pending invitation"
                                          : "pending invitations"}
                                  </span>
                              </span>
                          ),
                      }
                    : tab,
            )}
            rootHref="/settings"
        >
            {children}
        </SettingsShell>
    );
}
