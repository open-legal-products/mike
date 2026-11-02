import { useEffect, useState } from "react";
import { getOrgLogo, type Org } from "@/app/lib/mikeApi";

// One read per version of a logo, shared by everything that shows it. The
// version is the organization's logo_updated_at, so a changed logo is a new
// key and the old entry is simply never asked for again.
const cache = new Map<string, Promise<string | null>>();

function loadLogo(orgId: string, version: string): Promise<string | null> {
    const key = `${orgId}:${version}`;
    let pending = cache.get(key);
    if (!pending) {
        pending = getOrgLogo(orgId).catch(() => {
            // Not remembered: the next thing to ask tries again.
            cache.delete(key);
            return null;
        });
        cache.set(key, pending);
    }
    return pending;
}

/** For tests: forget every logo that was read. */
export function clearOrganizationLogoCache() {
    cache.clear();
}

/**
 * An organization's logo, as something an <img> can show.
 *
 *   undefined  it has one, which is still on its way
 *   null       it has none (or it could not be read)
 *   string     the logo, as a data URL
 *
 * The difference between the first two lets a caller hold the logo's place
 * instead of showing a fallback for a moment and then replacing it.
 */
export function useOrganizationLogo(
    org: Pick<Org, "id" | "logo_updated_at"> | null | undefined,
): string | null | undefined {
    const orgId = org?.id ?? null;
    const version = org?.logo_updated_at ?? null;
    const key = orgId && version ? `${orgId}:${version}` : null;
    const [loaded, setLoaded] = useState<{
        key: string;
        logo: string | null;
    } | null>(null);

    useEffect(() => {
        if (!orgId || !version) return;
        let cancelled = false;
        const requested = `${orgId}:${version}`;
        void loadLogo(orgId, version).then((logo) => {
            if (!cancelled) setLoaded({ key: requested, logo });
        });
        return () => {
            cancelled = true;
        };
    }, [orgId, version]);

    if (!key) return null;
    return loaded?.key === key ? loaded.logo : undefined;
}
