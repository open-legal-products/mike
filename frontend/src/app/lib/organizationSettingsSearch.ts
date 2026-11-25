import type { SettingsSearchEntry } from "@/app/lib/settingsSearch";

/**
 * The search index over an organization's own settings (Organization
 * Settings, or the Organization page for a member), in the same shape as a person's
 * Settings so the same search drives both. `tabId` is the section's id in
 * the organization's settings; entries on a section the caller is not
 * offered are left out by the caller.
 */
export function organizationSettingsSearchEntries(
    orgId: string,
): SettingsSearchEntry[] {
    const root = `/organizations/${orgId}/settings`;
    return [
        // General
        {
            id: "org-general-details",
            tabId: "general",
            tab: "General",
            title: "Organization name and logo",
            description: "The organization's name, and the logo shown in the sidebar.",
            keywords: ["name", "rename", "logo", "image", "picture", "brand", "branding", "icon", "details", "upload logo"],
            href: `${root}/general#org-general-details`,
        },
        {
            id: "org-general-membership",
            tabId: "general",
            tab: "General",
            title: "Your membership",
            description: "Your role in the organization, and leaving it.",
            keywords: ["role", "my role", "leave", "leave organization", "quit", "exit", "membership"],
            href: `${root}/general#org-general-membership`,
        },
        {
            id: "org-general-delete",
            tabId: "general",
            tab: "General",
            title: "Delete organization",
            description: "Delete the organization; owners can restore it within 30 days.",
            keywords: ["delete", "remove", "close", "shut down", "danger", "restore", "recover"],
            href: `${root}/general#org-general-delete`,
        },
        // Members
        {
            id: "org-members",
            tabId: "members",
            tab: "Members",
            title: "Members",
            description: "Everyone in the organization, their roles, and inviting more people.",
            keywords: ["people", "users", "team", "roster", "invite", "invitation", "add member", "role", "admin", "owner", "remove member", "permissions"],
            href: `${root}/members`,
        },
        {
            id: "org-members-departed",
            tabId: "members",
            tab: "Members",
            title: "Departed members",
            description: "People who have left, and the work they left behind.",
            keywords: ["former", "left", "removed", "offboarding", "reassign", "transfer", "successor"],
            href: `${root}/members?view=departed`,
        },
        // Audit log
        {
            id: "org-audit",
            tabId: "audit",
            tab: "Audit log",
            title: "Audit log",
            description: "A record of what members have done in the organization.",
            keywords: ["activity", "history", "log", "events", "compliance", "who did what", "trail", "security"],
            href: `${root}/audit`,
        },
        // API Keys
        {
            id: "org-providers",
            tabId: "providers",
            tab: "API Keys",
            title: "Organization providers",
            description: "The model provider keys everyone's work in the organization runs on.",
            keywords: ["byok", "bring your own keys", "api key", "api keys", "key", "keys", "token", "secret", "credentials", "provider", "providers", "model provider", "anthropic", "claude", "openai", "gpt", "gemini", "google", "mistral", "xai", "bedrock", "azure", "vertex", "openrouter", "custom endpoint", "no models", "missing key"],
            href: `${root}/providers`,
        },
        // Privacy & Data
        {
            id: "org-privacy-members",
            tabId: "privacy-data",
            tab: "Privacy & Data",
            title: "Members' data",
            description: "Whether members may export their data or delete it in bulk.",
            keywords: ["export", "download", "bulk delete", "data", "gdpr", "privacy", "allow export"],
            href: `${root}/privacy-data#org-privacy-members`,
        },
        {
            id: "org-privacy-departed",
            tabId: "privacy-data",
            tab: "Privacy & Data",
            title: "Work left by departed members",
            description: "What happens to the work of people who leave.",
            keywords: ["departed", "former", "left", "retention", "reassign", "orphaned"],
            href: `${root}/privacy-data#org-privacy-departed`,
        },
        {
            id: "org-privacy-delete",
            tabId: "privacy-data",
            tab: "Privacy & Data",
            title: "Delete data",
            description: "Delete all of the organization's chats, reviews, projects, playbooks or memory.",
            keywords: ["delete", "erase", "purge", "wipe", "clear", "chats", "tabular reviews", "projects", "playbooks", "memory", "retention"],
            href: `${root}/privacy-data#org-privacy-delete`,
        },
    ];
}
