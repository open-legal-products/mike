"use client";

import { useOrganizationLogo } from "@/app/hooks/useOrganizationLogo";
import type { Org } from "@/app/lib/mikeApi";
import { MikeIcon } from "@/shared/ui/MikeIconUI";

/**
 * The mark at the top of the sidebar: the active organization's own logo
 * when it has set one, and the app's otherwise. Only here — everywhere else
 * in the app the app's logo stays.
 *
 * While an organization's logo is on its way its place is held empty, so the
 * app's logo is not shown for a moment and then swapped out.
 */
export function SidebarLogo({
    organization,
    size = 18,
}: {
    /** The active organization, or null in the personal workspace. */
    organization: Pick<Org, "id" | "name" | "logo_updated_at"> | null;
    size?: number;
}) {
    const logo = useOrganizationLogo(organization);
    if (logo === null) return <MikeIcon size={size} />;
    const box = { width: size, height: size };
    if (logo === undefined)
        return (
            <span
                data-slot="sidebar-logo-loading"
                aria-hidden="true"
                className="block"
                style={box}
            />
        );
    return (
        // A data URL the server validated as PNG, JPEG or WebP. Decorative:
        // the organization's name is the text right beside it.
        // eslint-disable-next-line @next/next/no-img-element -- a small inline data URL, not an optimizable remote image
        <img
            data-slot="sidebar-logo"
            src={logo}
            alt=""
            className="block rounded-[3px] object-contain"
            style={box}
        />
    );
}
