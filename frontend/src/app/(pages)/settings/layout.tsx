"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/app/contexts/AuthContext";
import { useOrganizationInvitationCount } from "@/app/hooks/useOrganizationInvitationCount";
import { useMemberDataActions } from "@/app/hooks/useMemberDataActions";
import { useWorkspaceSettingsScope } from "@/app/hooks/useWorkspaceSettingsScope";
import { SettingsShell } from "@/app/components/settings/SettingsShell";
import type { SettingsSectionGroup } from "@/app/components/settings/settingsSections";
import {
    AccountSkeuoIcon,
    ActivitySkeuoIcon,
    AppearanceSkeuoIcon,
    FeaturesSkeuoIcon,
    KeysSkeuoIcon,
    MemorySkeuoIcon,
    ModelsSkeuoIcon,
    PersonalisationSkeuoIcon,
    PrivacySkeuoIcon,
    SecuritySkeuoIcon,
} from "@/app/components/shared/SettingsSkeuoIcons";
import {
    ConnectorSkeuoIcon,
    OrganizationSkeuoIcon,
} from "@/app/components/shared/AppSidebarSkeuoIcons";
import { SettingsSearch } from "@/app/components/settings/SettingsSearch";
import { SETTINGS_SEARCH_ENTRIES } from "@/app/lib/settingsSearch";

// Settings come in two groups, the person's own first. Workspace settings
// belong to the workspace in view (Personal, or one of the person's
// organizations): each workspace keeps
// its own, and switching workspace switches them. In Personal they are the
// person's own; in an organization's workspace, Features and Model
// Preferences are the organization's, and its keys are managed only in its
// own settings. Personal settings are the person's own and follow them into
// every workspace. /settings itself is the overview, every section as a card.
const GROUPS: SettingsSectionGroup[] = [
    {
        id: "personal",
        label: "Personal",
        sections: [
            {
                id: "account",
                label: "Account",
                description: "Your name, photo, email and plan.",
                href: "/settings/account",
                icon: AccountSkeuoIcon,
            },
            {
                id: "personalisation",
                label: "Personalisation",
                description: "Your background, and how Mike shapes its answers.",
                href: "/settings/personalisation",
                icon: PersonalisationSkeuoIcon,
            },
            {
                id: "appearance",
                label: "Appearance",
                description: "Light or dark mode.",
                href: "/settings/appearance",
                icon: AppearanceSkeuoIcon,
            },
            {
                id: "security",
                label: "Security",
                description: "Your password and multi-factor authentication.",
                href: "/settings/security",
                icon: SecuritySkeuoIcon,
            },
            {
                id: "my-activity",
                label: "My Activity",
                description: "A log of what you have done in Mike.",
                href: "/settings/my-activity",
                icon: ActivitySkeuoIcon,
            },
            // The organizations the person belongs to, and their invitations.
            // Each organization's own settings are a separate area, opened
            // from here or from the account menu.
            {
                id: "organizations",
                label: "Organizations",
                description: "The organizations you belong to, and your invitations.",
                href: "/settings/organizations",
                icon: OrganizationSkeuoIcon,
            },
        ],
    },
    {
        id: "workspace",
        label: "Workspace",
        sections: [
            {
                id: "memory",
                label: "Memory",
                description: "What Mike remembers about you, and whether it remembers at all.",
                href: "/settings/memory",
                icon: MemorySkeuoIcon,
            },
            {
                id: "connectors",
                label: "Connectors",
                description: "The data sources and tools Mike can use in this workspace.",
                href: "/settings/connectors",
                icon: ConnectorSkeuoIcon,
            },
            {
                id: "features",
                label: "Features",
                description: "Quick actions, web search and the details shown under each response.",
                href: "/settings/features",
                icon: FeaturesSkeuoIcon,
            },
            {
                id: "models",
                label: "Model Preferences",
                description: "The models Mike uses for titles, reviews, memory and subagents.",
                href: "/settings/models",
                icon: ModelsSkeuoIcon,
            },
            {
                id: "byok",
                label: "API Keys",
                description: "Your own keys for model providers such as Anthropic and OpenAI.",
                href: "/settings/byok",
                icon: KeysSkeuoIcon,
            },
            {
                id: "privacy-data",
                label: "Privacy & Data",
                description: "Export your data, or delete it in bulk.",
                href: "/settings/privacy-data",
                icon: PrivacySkeuoIcon,
            },
        ],
    },
];

// In an organization's workspace these are the organization's, set by its
// owners and admins for everyone working there; a member has nothing to
// change, so they are not listed (useWorkspaceSettingsScope).
const GOVERNED_TAB_IDS = new Set(["features", "models"]);
// An organization's keys are managed only in its own settings, by its owners
// and admins, so API Keys is listed only in Personal.
const PERSONAL_ONLY_TAB_IDS = new Set(["byok"]);

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
    const scope = useWorkspaceSettingsScope().kind;
    const hideGoverned = scope !== "personal" && scope !== "organization";
    const hidePersonalOnly = scope !== "personal";
    const visibleGroups = useMemo(
        () =>
            GROUPS.map((group) => ({
                ...group,
                sections: group.sections.filter(
                    (section) =>
                        !(hidePrivacyData && section.id === "privacy-data") &&
                        !(hideGoverned && GOVERNED_TAB_IDS.has(section.id)) &&
                        !(
                            hidePersonalOnly &&
                            PERSONAL_ONLY_TAB_IDS.has(section.id)
                        ),
                ),
            })),
        [hideGoverned, hidePersonalOnly, hidePrivacyData],
    );
    // Search only what is listed: an entry on a hidden tab would open a page
    // the person is not offered.
    const searchEntries = useMemo(() => {
        const visibleTabIds = new Set(
            visibleGroups.flatMap((group) =>
                group.sections.map((section) => section.id),
            ),
        );
        return SETTINGS_SEARCH_ENTRIES.filter((entry) =>
            visibleTabIds.has(entry.tabId),
        );
    }, [visibleGroups]);
    const groups = useMemo(
        () =>
            // Which sections a workspace offers is known once its scope is.
            scope === "loading"
                ? null
                : visibleGroups.map((group) => ({
                      ...group,
                      sections: group.sections.map((section) =>
                          section.id === "organizations" && invitationCount > 0
                              ? {
                                    ...section,
                                    badge: (
                                        <InvitationCountBadge
                                            count={invitationCount}
                                        />
                                    ),
                                }
                              : section,
                      ),
                  })),
        [scope, visibleGroups, invitationCount],
    );

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
            rootHref="/settings"
            groups={groups}
            search={<SettingsSearch entries={searchEntries} />}
        >
            {children}
        </SettingsShell>
    );
}

function InvitationCountBadge({ count }: { count: number }) {
    return (
        <span className="ml-2 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-semibold tabular-nums text-white">
            {count}{" "}
            <span className="sr-only">
                {count === 1 ? "pending invitation" : "pending invitations"}
            </span>
        </span>
    );
}
