import { EmptyState } from "@/app/components/ui/empty-state";

/**
 * Shown to a member of an organization who opens one of the settings its
 * owners and admins set for everyone working in its workspace. Settings does
 * not list those pages for a member; this is for one who follows a link.
 */
export function ManagedByOrganization({
    subject,
    orgName,
}: {
    /** What the page sets, as a plural noun phrase: "Features". */
    subject: string;
    orgName: string;
}) {
    return (
        <EmptyState
            title="Managed by your organization"
            description={`${subject} in ${orgName} are set by its owners and admins for everyone working there.`}
        />
    );
}
