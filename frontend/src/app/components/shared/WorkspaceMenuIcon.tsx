"use client";

import { useOrganizationLogo } from "@/app/hooks/useOrganizationLogo";
import type { Org } from "@/app/lib/mikeApi";
import { MikeIcon } from "@mike/ui";
import { avatarColour } from "@/app/components/ui/user-avatar";
import { cn } from "@/app/lib/utils";

const SIZE = 16;

/**
 * The mark beside a workspace in the workspace menu: the app's logo for
 * personal work, an organization's own logo when it has set one, and its
 * initial on a coloured circle when it has not. The colour comes from the
 * organization's id, as a person's monogram does from their email, so it
 * stays the same everywhere and through a rename. Unlike the sidebar's header the
 * app's logo is not the fallback here: in a list it would make every
 * organization without a logo look like personal work.
 */
export function WorkspaceMenuIcon({
    organization,
}: {
    /** The organization, or null for the personal workspace. */
    organization: Pick<Org, "id" | "name" | "logo_updated_at"> | null;
}) {
    const logo = useOrganizationLogo(organization);
    const box = { width: SIZE, height: SIZE };
    if (!organization) return <MikeIcon size={SIZE} />;
    if (logo === undefined)
        // On its way: its place is held, so nothing is shown and swapped.
        return (
            <span
                data-slot="workspace-icon-loading"
                className="block"
                style={box}
            />
        );
    if (logo === null)
        return (
            <span
                data-slot="workspace-icon-placeholder"
                className={cn(
                    "flex items-center justify-center rounded-full font-serif text-[10px] font-medium leading-none text-white",
                    avatarColour(null, organization.id),
                )}
                style={box}
            >
                {organization.name.trim().charAt(0).toUpperCase() || "?"}
            </span>
        );
    return (
        // A data URL the server validated as PNG, JPEG or WebP. Decorative:
        // the organization's name is the text right beside it.
        // eslint-disable-next-line @next/next/no-img-element -- a small inline data URL, not an optimizable remote image
        <img
            data-slot="workspace-icon"
            src={logo}
            alt=""
            className="block rounded-[3px] object-contain"
            style={box}
        />
    );
}
